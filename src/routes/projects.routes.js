import { Router } from 'express';
import { z } from 'zod';
import { Dashboard, DashboardTemplate, DashboardVersion, Device, Instrument, InstrumentCatalog, Project, ProjectMember, RuleSet, SensorChannel, Site, UseCaseTemplate, Zone } from '../models/index.js';
import { requireAuth, requireProjectAccess } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { audit } from '../services/audit.service.js';
import { getProjectOverview } from '../services/overview.service.js';
import { getPortfolioSummary } from '../services/portfolio.service.js';

const router = Router();
router.use(requireAuth);

const createProjectSchema = z.object({
  useCaseTemplateId: z.string().min(1),
  project: z.object({ name: z.string().min(3), code: z.string().min(2), clientName: z.string().optional().default(''), location: z.string().optional().default(''), timezone: z.string().default('Asia/Kolkata') }),
  hierarchy: z.array(z.object({ type: z.string().min(1), name: z.string().min(1) })).min(1),
  instruments: z.array(z.object({ catalogCode: z.string().min(1) })).default([]),
  devices: z.array(z.object({ deviceId: z.string().min(1), name: z.string().min(1), deviceType: z.string().default('LOGGER'), transport: z.string().default('4G') })).default([]),
  dashboardTemplateId: z.string().nullable().optional(),
  ruleSetId: z.string().nullable().optional(),
  correlations: z.array(z.string()).default([])
});

router.get('/projects', asyncHandler(async (req, res) => {
  let projectIds = null;
  if (req.auth.organizationRole !== 'ADMINISTRATOR') {
    const memberships = await ProjectMember.find({ userId: req.auth.userId, status: 'ACTIVE' }).select('projectId').lean();
    projectIds = memberships.map((m) => m.projectId);
  }
  const q = { organizationId: req.auth.organizationId, ...(projectIds ? { _id: { $in: projectIds } } : {}) };
  const projects = await Project.find(q).sort({ createdAt: -1 }).lean();
  const summaries = await getPortfolioSummary(projects.map(p => p._id));
  const useCases = await UseCaseTemplate.find({ _id: { $in: projects.map((p) => p.useCaseTemplateId) } }).lean();
  const uc = new Map(useCases.map((x) => [x._id.toString(), x]));
  const result = await Promise.all(projects.map(async (p) => {
    const summary = summaries.get(p._id.toString()) || {};
    return {
      id: p._id, name: p.name, code: p.code, clientName: p.clientName || '', location: p.location, timezone: p.timezone, status: p.status, createdAt: p.createdAt,
      useCaseCode: p.useCaseCode, useCaseName: uc.get(p.useCaseTemplateId.toString())?.name || p.useCaseCode,
      ...summary
    };
  }));
  res.json(result);
}));

router.post('/projects', validate(createProjectSchema), asyncHandler(async (req, res) => {
  const body = req.body;
  const useCase = await UseCaseTemplate.findOne({ _id: body.useCaseTemplateId, status: 'APPROVED' });
  if (!useCase) throw new ApiError(400, 'Approved use-case template not found');
  if (await Project.exists({ organizationId: req.auth.organizationId, code: body.project.code.toUpperCase() })) throw new ApiError(409, 'Project code already exists');
  if (body.dashboardTemplateId && !(await DashboardTemplate.exists({ _id: body.dashboardTemplateId, status: 'APPROVED' }))) throw new ApiError(400, 'Dashboard template is not approved');
  if (body.ruleSetId && !(await RuleSet.exists({ _id: body.ruleSetId, status: { $in: ['APPROVED', 'ACTIVE'] } }))) throw new ApiError(400, 'Rule set is not approved');

  const project = await Project.create({ organizationId: req.auth.organizationId, name: body.project.name, code: body.project.code.toUpperCase(), clientName: body.project.clientName, location: body.project.location, timezone: body.project.timezone, useCaseTemplateId: useCase._id, useCaseCode: useCase.code, dashboardTemplateId: body.dashboardTemplateId || undefined, ruleSetId: body.ruleSetId || undefined, correlations: body.correlations, status: 'ACTIVE' });
  await ProjectMember.create({ projectId: project._id, userId: req.auth.userId, role: req.auth.organizationRole === 'ADMINISTRATOR' ? 'ADMINISTRATOR' : 'ENGINEER', status: 'ACTIVE' });

  let parentId = null; let firstSite = null; let firstZone = null;
  for (let i = 0; i < body.hierarchy.length; i++) {
    const item = body.hierarchy[i];
    if (/ZONE|STRUCTURE|SLOPE|SECTION|CHAINAGE/i.test(item.type) && i > 0) {
      const z = await Zone.create({ organizationId: project.organizationId, projectId: project._id, siteId: firstSite?._id, name: item.name, type: item.type.toUpperCase() });
      firstZone ||= z;
    } else {
      const s = await Site.create({ organizationId: project.organizationId, projectId: project._id, name: item.name, type: item.type.toUpperCase(), parentId, level: i });
      firstSite ||= s; parentId = s._id;
    }
  }

  const devices = [];
  for (const d of body.devices) {
    const apiKey = `gxn_${randomToken(16)}`;
    const doc = await Device.create({ organizationId: project.organizationId, projectId: project._id, deviceId: d.deviceId, name: d.name, deviceType: d.deviceType, transport: d.transport, apiKeyHash: sha256(apiKey), apiKeyPrefix: apiKey.slice(0, 10), status: 'PLANNED' });
    devices.push({ doc, apiKey });
  }

  const createdInstruments = [];
  for (let idx = 0; idx < body.instruments.length; idx++) {
    const selected = body.instruments[idx];
    const catalog = await InstrumentCatalog.findOne({ code: selected.catalogCode.toUpperCase() });
    if (!catalog) continue;
    const code = `${catalog.code}-${String(idx + 1).padStart(2, '0')}`;
    const instrument = await Instrument.create({ organizationId: project.organizationId, projectId: project._id, siteId: firstSite?._id, zoneId: firstZone?._id, catalogCode: catalog.code, name: `${catalog.name} ${idx + 1}`, code, status: 'PLANNED' });
    createdInstruments.push(instrument);
    for (const ch of catalog.defaultChannels || []) {
      await SensorChannel.create({ organizationId: project.organizationId, projectId: project._id, instrumentId: instrument._id, deviceId: devices[0]?.doc?._id, code: `${code}-${ch.code}`, sourceField: ch.sourceField || ch.code, parameterCode: ch.parameterCode, rawUnit: ch.rawUnit, engineeringUnit: ch.engineeringUnit, sampleIntervalSec: ch.sampleIntervalSec || 900, calibration: ch.calibration || { scale: 1, offset: 0, version: 1 }, baseline: ch.baseline || { value: 0, version: 1 }, qualityConfig: ch.qualityConfig || {} });
    }
  }

  const dashboard = await Dashboard.create({ organizationId: project.organizationId, projectId: project._id, name: 'Project Overview', ownerId: req.auth.userId, templateType: useCase.code });
  const template = body.dashboardTemplateId ? await DashboardTemplate.findById(body.dashboardTemplateId).lean() : null;
  const version = await DashboardVersion.create({ dashboardId: dashboard._id, versionNo: 1, status: 'DRAFT', layoutJson: template ? { widgets: template.widgets, layout: template.layout, sourceTemplateId: template._id } : { widgets: [], layout: {} }, schemaVersion: 1, createdBy: req.auth.userId });
  dashboard.currentDraftVersionId = version._id; await dashboard.save();
  await audit({ req, organizationId: project.organizationId, projectId: project._id, action: 'PROJECT_CREATED', resourceType: 'Project', resourceId: project._id, newState: project.toObject() });
  res.status(201).json({ projectId: project._id, status: 'CREATED', project, deviceCredentials: devices.map((x) => ({ deviceId: x.doc.deviceId, apiKey: x.apiKey })) });
}));

router.get('/projects/:projectId', requireProjectAccess, asyncHandler(async (req, res) => {
  const project = await Project.findOne({ _id: req.params.projectId, organizationId: req.auth.organizationId }).populate('useCaseTemplateId dashboardTemplateId ruleSetId').lean();
  if (!project) throw new ApiError(404, 'Project not found');
  const [sites, zones, instruments, devices] = await Promise.all([Site.find({ projectId: project._id }).sort({ level: 1, createdAt: 1 }).lean(), Zone.find({ projectId: project._id }).sort({ createdAt: 1 }).lean(), Instrument.find({ projectId: project._id }).sort({ name: 1 }).lean(), Device.find({ projectId: project._id }).sort({ name: 1 }).lean()]);
  const catalog = await InstrumentCatalog.find({ code: { $in: instruments.map((i) => i.catalogCode) } }).lean();
  const categories = new Map(catalog.map((c) => [c.code, c.category]));
  const compatible = {
    id: project._id,
    name: project.name,
    code: project.code,
    clientName: project.clientName,
    location: project.location,
    timezone: project.timezone,
    status: project.status,
    use_case_code: project.useCaseCode,
    use_case_name: project.useCaseTemplateId?.name || project.useCaseCode,
    dashboard_template_name: project.dashboardTemplateId?.name || null,
    rule_set_name: project.ruleSetId?.name || null,
    hierarchy: [...sites.map((x) => ({ id: x._id, node_type: x.type, name: x.name, level: x.level })), ...zones.map((x) => ({ id: x._id, node_type: x.type, name: x.name, level: 999 }))],
    instruments: instruments.map((i) => ({ id: i._id, name: i.name, code: i.code, category: categories.get(i.catalogCode) || 'Engineering', catalogCode: i.catalogCode, status: i.status, serial: i.serial })),
    devices: devices.map((d) => ({ id: d._id, name: d.name, deviceId: d.deviceId, deviceType: d.deviceType, transport: d.transport, status: d.status, healthGrade: d.healthGrade, lastSeenAt: d.lastSeenAt })),
    _raw: { project, sites, zones }
  };
  res.json(compatible);
}));

router.get('/projects/:projectId/overview', requireProjectAccess, asyncHandler(async (req, res) => {
  const data = await getProjectOverview(req.params.projectId);
  if (!data) throw new ApiError(404, 'Project not found');
  res.json(data);
}));

router.patch('/projects/:projectId', requireProjectAccess, asyncHandler(async (req, res) => {
  const project = await Project.findById(req.params.projectId); if (!project) throw new ApiError(404, 'Project not found');
  const before = project.toObject();
  for (const key of ['name', 'clientName', 'location', 'timezone', 'status', 'metadata']) if (req.body[key] !== undefined) project[key] = req.body[key];
  await project.save(); await audit({ req, organizationId: project.organizationId, projectId: project._id, action: 'PROJECT_UPDATED', resourceType: 'Project', resourceId: project._id, previousState: before, newState: project.toObject() });
  res.json(project);
}));

export default router;
