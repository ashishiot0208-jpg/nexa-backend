import { Router } from 'express';
import { DashboardTemplate, InstrumentCatalog, RuleSet, UseCaseTemplate, ProjectTemplate, Sensor, DeviceCatalogue, GatewayCatalogue } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();
router.use(requireAuth);

async function resolveTemplateItems(templates) {
  const allSensorUids = [...new Set(templates.flatMap(t => (t.sensors || []).map(s => s.sensor_uid)))];
  const allDeviceUids = [...new Set(templates.flatMap(t => (t.devices || []).map(d => d.device_uid)))];
  const allGatewayUids = [...new Set(templates.flatMap(t => (t.gateways || []).map(g => g.gateway_uid)))];

  const [sensors, devices, gateways] = await Promise.all([
    Sensor.find({ uid: { $in: allSensorUids } }).lean(),
    DeviceCatalogue.find({ uid: { $in: allDeviceUids } }).lean(),
    GatewayCatalogue.find({ uid: { $in: allGatewayUids } }).lean()
  ]);

  const sensorMap = new Map(sensors.map(s => [s.uid, s]));
  const deviceMap = new Map(devices.map(d => [d.uid, d]));
  const gatewayMap = new Map(gateways.map(g => [g.uid, g]));

  return templates.map(t => {
    const resolvedSensors = (t.sensors || []).map(s => {
      const item = sensorMap.get(s.sensor_uid);
      return {
        sensor_uid: s.sensor_uid,
        default_quantity: s.default_quantity,
        name: item?.name || s.sensor_uid,
        model: item?.model || '',
        type: item?.type || '',
        signal_type: item?.signal_type || '',
        channels: item?.channels || []
      };
    });
    const resolvedDevices = (t.devices || []).map(d => {
      const item = deviceMap.get(d.device_uid);
      return {
        device_uid: d.device_uid,
        default_quantity: d.default_quantity,
        name: item?.name || d.device_uid,
        model: item?.model || '',
        type: item?.type || '',
        communication: item?.communication || '',
        supported_signal_types: item?.supported_signal_types || [],
        max_channels: item?.max_channels || 1
      };
    });
    const resolvedGateways = (t.gateways || []).map(g => {
      const item = gatewayMap.get(g.gateway_uid);
      return {
        gateway_uid: g.gateway_uid,
        default_quantity: g.default_quantity,
        name: item?.name || g.gateway_uid,
        model: item?.model || '',
        type: item?.type || '',
        supported_device_communications: item?.supported_device_communications || [],
        backhaul: item?.backhaul || [],
        max_devices: item?.max_devices || 1
      };
    });
    return {
      id: t._id,
      uid: t.uid,
      name: t.name,
      type: t.type,
      description: t.description || '',
      status: t.status,
      sensorCount: resolvedSensors.length,
      deviceCount: resolvedDevices.length,
      gatewayCount: resolvedGateways.length,
      sensors: resolvedSensors,
      devices: resolvedDevices,
      gateways: resolvedGateways
    };
  });
}

// Normal user read-only endpoint for active project templates
router.get('/project-templates', asyncHandler(async (_req, res) => {
  const rows = await ProjectTemplate.find({ status: 'active' }).sort({ name: 1 }).lean();
  const populated = await resolveTemplateItems(rows);
  res.json(populated);
}));

router.get('/project-templates/:id', asyncHandler(async (req, res) => {
  const t = await ProjectTemplate.findOne({
    $or: [{ _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null }, { uid: req.params.id }],
    status: 'active'
  }).lean();
  if (!t) throw new ApiError(404, 'Active project template not found');
  const [populated] = await resolveTemplateItems([t]);
  res.json(populated);
}));

// Normal user read-only endpoints for active catalogue items
router.get('/catalogue/sensors', asyncHandler(async (_req, res) => {
  const rows = await Sensor.find({ status: 'active' }).sort({ name: 1 }).lean();
  res.json(rows.map(s => ({
    uid: s.uid,
    name: s.name,
    type: s.type,
    model: s.model || '',
    signal_type: s.signal_type,
    channels: s.channels || []
  })));
}));

router.get('/catalogue/devices', asyncHandler(async (_req, res) => {
  const rows = await DeviceCatalogue.find({ status: 'active' }).sort({ name: 1 }).lean();
  res.json(rows.map(d => ({
    uid: d.uid,
    name: d.name,
    type: d.type,
    model: d.model || '',
    communication: d.communication,
    supported_signal_types: d.supported_signal_types || [],
    max_channels: d.max_channels
  })));
}));

router.get('/catalogue/gateways', asyncHandler(async (_req, res) => {
  const rows = await GatewayCatalogue.find({ status: 'active' }).sort({ name: 1 }).lean();
  res.json(rows.map(g => ({
    uid: g.uid,
    name: g.name,
    type: g.type,
    model: g.model || '',
    supported_device_communications: g.supported_device_communications || [],
    backhaul: g.backhaul || [],
    max_devices: g.max_devices
  })));
}));

// Legacy endpoints preserved for backwards compatibility
router.get('/use-case-templates', asyncHandler(async (_req, res) => {
  const rows = await UseCaseTemplate.find({ status: 'APPROVED' }).sort({ name: 1 }).lean();
  res.json(rows.map((u) => ({ id: u._id, code: u.code, name: u.name, summary: u.summary, recommendedHierarchy: u.recommendedHierarchy, recommendedInstruments: u.recommendedInstruments, recommendedCorrelations: u.recommendedCorrelations, terminology: u.terminology || {}, dashboardTemplateName: u.dashboardTemplateName, version: u.version })));
}));

router.get('/instrument-catalog', asyncHandler(async (_req, res) => {
  const rows = await InstrumentCatalog.find().sort({ category: 1, name: 1 }).lean();
  res.json(rows.map((x) => ({ id: x._id, code: x.code, name: x.name, category: x.category, parameters: x.parameters, defaultVisualizations: x.defaultVisualizations, defaultChannels: x.defaultChannels })));
}));

router.get('/configuration/:code', asyncHandler(async (req, res) => {
  const useCase = await UseCaseTemplate.findOne({ code: req.params.code.toUpperCase(), status: 'APPROVED' }).lean();
  if (!useCase) throw new ApiError(404, 'Use-case template not found');
  const [dashboards, ruleSets] = await Promise.all([
    DashboardTemplate.find({ status: 'APPROVED', useCaseCodes: useCase.code }).sort({ version: -1 }).lean(),
    RuleSet.find({ status: { $in: ['APPROVED', 'ACTIVE'] }, $or: [{ organizationId: req.auth.organizationId }, { organizationId: null }], useCaseCodes: useCase.code }).sort({ version: -1 }).lean()
  ]);
  res.json({ useCase: { ...useCase, id: useCase._id }, dashboards: dashboards.map((d) => ({ id: d._id, name: d.name, version: d.version, status: d.status })), ruleSets: ruleSets.map((r) => ({ id: r._id, name: r.name, version: r.version, status: r.status, description: r.description })) });
}));

export default router;
