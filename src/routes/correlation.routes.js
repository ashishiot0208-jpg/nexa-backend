import { Router } from 'express';
import mongoose from 'mongoose';
import { BacktestRun, CorrelationModel, Device, ProjectGateway } from '../models/index.js';
import { requireAuth, requireProjectAccess, requireProjectPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { executeBacktest, validateGraph } from '../services/correlation.service.js';
import { audit } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth);

/**
 * Middleware that loads model or backtest to resolve projectId for requireProjectAccess.
 */
async function resolveProjectFromResource(req, _res, next) {
  try {
    if (req.params.id) {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new ApiError(400, 'Invalid resource id');
      const m = await CorrelationModel.findById(req.params.id).select('projectId organizationId').lean();
      if (!m) throw new ApiError(404, 'Correlation model not found');
      req.params.projectId = m.projectId.toString();
      req.resolvedModel = m;
    } else if (req.params.backtestId) {
      if (!mongoose.Types.ObjectId.isValid(req.params.backtestId)) throw new ApiError(400, 'Invalid backtest id');
      const b = await BacktestRun.findById(req.params.backtestId).select('projectId').lean();
      if (!b) throw new ApiError(404, 'Backtest not found');
      req.params.projectId = b.projectId.toString();
      req.resolvedBacktest = b;
    }
    next();
  } catch (err) {
    next(err);
  }
}

function resolveBacktestTimeRange(body) {
  const endAt = body.endAt ? new Date(body.endAt) : new Date();
  if (Number.isNaN(endAt.getTime())) throw new ApiError(400, 'Invalid endAt timestamp');

  let startAt = body.startAt ? new Date(body.startAt) : null;
  const period = String(body.period || '').trim().toLowerCase();

  if (period === '24h') {
    startAt = new Date(endAt.getTime() - 24 * 3600 * 1000);
  } else if (period === '7d') {
    startAt = new Date(endAt.getTime() - 7 * 86400 * 1000);
  } else if (period === '30d') {
    startAt = new Date(endAt.getTime() - 30 * 86400 * 1000);
  } else if (!startAt || Number.isNaN(startAt.getTime())) {
    startAt = new Date(endAt.getTime() - 7 * 86400 * 1000);
  }

  if (startAt >= endAt) {
    throw new ApiError(400, 'Invalid time range: startAt must be before endAt');
  }

  return { startAt, endAt };
}

// 1. List correlation models for a project
router.get(
  '/projects/:projectId/correlation-models',
  requireProjectAccess,
  requireProjectPermission('correlation.view'),
  asyncHandler(async (req, res) => {
    const projectId = req.project?._id || req.projectId || req.params.projectId;
    const list = await CorrelationModel.find({
      projectId,
      organizationId: req.auth.organizationId
    })
      .sort({ updatedAt: -1 })
      .lean();
    res.json(list);
  })
);

// Read-only project devices for correlation configuration
router.get(
  '/projects/:projectId/correlation-devices',
  requireProjectAccess,
  requireProjectPermission('correlation.view'),
  asyncHandler(async (req, res) => {
    const projectId = req.project?._id || req.projectId || req.params.projectId;
    const devices = await Device.find({ 
      projectId, 
      status: { $ne: 'DECOMMISSIONED' } 
    })
      .select('_id deviceId name model transport status lastBatteryV lastRssiDbm projectId')
      .sort({ deviceId: 1 })
      .lean();
    res.json(devices);
  })
);

// Read-only project gateways for correlation configuration
router.get(
  '/projects/:projectId/correlation-gateways',
  requireProjectAccess,
  requireProjectPermission('correlation.view'),
  asyncHandler(async (req, res) => {
    const projectId = req.project?._id || req.projectId || req.params.projectId;
    const gateways = await ProjectGateway.find({ 
      projectId, 
      status: { $ne: 'DECOMMISSIONED' } 
    })
      .select('_id gatewayId name model status activeBackhaul updatedAt projectId')
      .sort({ gatewayId: 1 })
      .lean();
    res.json(gateways);
  })
);

// 2. Get single correlation model
router.get(
  '/correlation-models/:id',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.view'),
  asyncHandler(async (req, res) => {
    const model = await CorrelationModel.findOne({
      _id: req.params.id,
      organizationId: req.auth.organizationId
    }).lean();
    if (!model) throw new ApiError(404, 'Correlation model not found');
    res.json(model);
  })
);

// Also support scoped route /projects/:projectId/correlation-models/:id
router.get(
  '/projects/:projectId/correlation-models/:id',
  requireProjectAccess,
  requireProjectPermission('correlation.view'),
  asyncHandler(async (req, res) => {
    const projectId = req.project?._id || req.projectId || req.params.projectId;
    const model = await CorrelationModel.findOne({
      _id: req.params.id,
      projectId,
      organizationId: req.auth.organizationId
    }).lean();
    if (!model) throw new ApiError(404, 'Correlation model not found');
    res.json(model);
  })
);

// 3. Create correlation model
router.post(
  '/correlation-models',
  requireProjectAccess,
  requireProjectPermission('correlation.configure'),
  asyncHandler(async (req, res) => {
    const graph = req.body.graphJson || { nodes: [], edges: [] };
    const validation = validateGraph(graph);

    const model = await CorrelationModel.create({
      organizationId: req.auth.organizationId,
      projectId: req.body.projectId,
      name: req.body.name || 'Untitled Correlation Flow',
      purpose: req.body.purpose || 'Correlation analysis flow',
      scope: req.body.scope || {},
      ownerId: req.auth.userId,
      status: 'DRAFT',
      versions: [{
        version: 1,
        graphJson: graph,
        schemaVersion: 1,
        validationResult: validation,
        status: 'DRAFT',
        checksum: validation.checksum
      }],
      activeVersion: 1
    });

    res.status(201).json(model);
  })
);

// Also support scoped route POST /projects/:projectId/correlation-models
router.post(
  '/projects/:projectId/correlation-models',
  requireProjectAccess,
  requireProjectPermission('correlation.configure'),
  asyncHandler(async (req, res) => {
    const graph = req.body.graphJson || { nodes: [], edges: [] };
    const validation = validateGraph(graph);

    const projectId = req.project?._id || req.projectId || req.params.projectId;
    const model = await CorrelationModel.create({
      organizationId: req.auth.organizationId,
      projectId,
      name: req.body.name || 'Untitled Correlation Flow',
      purpose: req.body.purpose || 'Correlation analysis flow',
      scope: req.body.scope || {},
      ownerId: req.auth.userId,
      status: 'DRAFT',
      versions: [{
        version: 1,
        graphJson: graph,
        schemaVersion: 1,
        validationResult: validation,
        status: 'DRAFT',
        checksum: validation.checksum
      }],
      activeVersion: 1
    });

    res.status(201).json(model);
  })
);

// 4. Update model version (Save Flow)
router.put(
  '/correlation-models/:id/versions/:v',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.configure'),
  asyncHandler(async (req, res) => {
    const m = await CorrelationModel.findOne({
      _id: req.params.id,
      organizationId: req.auth.organizationId
    });
    if (!m) throw new ApiError(404, 'Correlation model not found');

    const v = Number(req.params.v);
    const graph = req.body.graphJson || { nodes: [], edges: [] };
    const validation = validateGraph(graph);

    if (req.body.name) m.name = req.body.name;
    if (req.body.purpose) m.purpose = req.body.purpose;

    const idx = m.versions.findIndex(x => x.version === v);
    const item = {
      version: v,
      graphJson: graph,
      schemaVersion: 1,
      validationResult: validation,
      status: 'DRAFT',
      checksum: validation.checksum
    };

    if (idx >= 0) {
      m.versions[idx] = item;
    } else {
      m.versions.push(item);
    }

    m.status = 'DRAFT';
    await m.save();

    res.json({ modelId: m._id, version: v, validation, model: m });
  })
);

// 5. Delete model (if in draft)
router.delete(
  '/correlation-models/:id',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.configure'),
  asyncHandler(async (req, res) => {
    const m = await CorrelationModel.findOne({
      _id: req.params.id,
      organizationId: req.auth.organizationId
    });
    if (!m) throw new ApiError(404, 'Correlation model not found');

    await CorrelationModel.deleteOne({ _id: m._id });
    await BacktestRun.deleteMany({ modelId: m._id });

    res.json({ success: true, message: 'Correlation model deleted' });
  })
);

// 6. Trigger Run Analysis (Backtest)
router.post(
  '/correlation-models/:id/backtests',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.configure'),
  asyncHandler(async (req, res) => {
    const m = await CorrelationModel.findOne({
      _id: req.params.id,
      organizationId: req.auth.organizationId
    }).lean();
    if (!m) throw new ApiError(404, 'Correlation model not found');

    const versionNum = Number(req.body.version || m.activeVersion || m.versions.at(-1)?.version || 1);
    const { startAt, endAt } = resolveBacktestTimeRange(req.body);

    const run = await BacktestRun.create({
      projectId: m.projectId,
      modelId: m._id,
      modelVersion: versionNum,
      startAt,
      endAt,
      status: 'QUEUED',
      progress: 0
    });

    setImmediate(() => executeBacktest(run._id));
    res.status(202).json(run);
  })
);

// 7. Get BacktestRun status & results
router.get(
  '/backtests/:backtestId',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.view'),
  asyncHandler(async (req, res) => {
    const r = await BacktestRun.findById(req.params.backtestId).lean();
    if (!r) throw new ApiError(404, 'Backtest run not found');
    res.json(r);
  })
);

// 8. Submit version
router.post(
  '/correlation-models/:id/versions/:v/submit',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.configure'),
  asyncHandler(async (req, res) => {
    const m = await CorrelationModel.findOne({
      _id: req.params.id,
      organizationId: req.auth.organizationId
    });
    if (!m) throw new ApiError(404, 'Model not found');

    const item = m.versions.find(x => x.version === Number(req.params.v));
    if (!item) throw new ApiError(404, 'Version not found');
    if (!item.validationResult?.valid) throw new ApiError(409, 'Graph validation failed');

    item.status = 'SUBMITTED';
    item.submittedAt = new Date();
    m.status = 'SUBMITTED';
    await m.save();

    res.json(m);
  })
);

// 9. Approve version
router.post(
  '/correlation-models/:id/versions/:v/approve',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.activate'),
  asyncHandler(async (req, res) => {
    const m = await CorrelationModel.findOne({
      _id: req.params.id,
      organizationId: req.auth.organizationId
    });
    if (!m) throw new ApiError(404, 'Model not found');

    const item = m.versions.find(x => x.version === Number(req.params.v));
    if (!item) throw new ApiError(404, 'Version not found');

    item.status = 'APPROVED';
    item.approvedAt = new Date();
    item.approvedBy = req.auth.userId;
    m.status = 'APPROVED';
    await m.save();

    await audit({
      req,
      projectId: m.projectId,
      action: 'CORRELATION_MODEL_APPROVED',
      resourceType: 'CorrelationModel',
      resourceId: m._id,
      reason: req.body.note
    });

    res.json(m);
  })
);

// 10. Activate version
router.post(
  '/correlation-models/:id/versions/:v/activate',
  resolveProjectFromResource,
  requireProjectAccess,
  requireProjectPermission('correlation.activate'),
  asyncHandler(async (req, res) => {
    const m = await CorrelationModel.findOne({
      _id: req.params.id,
      organizationId: req.auth.organizationId
    });
    if (!m) throw new ApiError(404, 'Model not found');

    const item = m.versions.find(x => x.version === Number(req.params.v));
    if (!item || item.status !== 'APPROVED') {
      throw new ApiError(409, 'Only approved versions can be activated');
    }

    m.activeVersion = item.version;
    m.status = 'ACTIVE';
    await m.save();

    await audit({
      req,
      projectId: m.projectId,
      action: 'CORRELATION_MODEL_ACTIVATED',
      resourceType: 'CorrelationModel',
      resourceId: m._id
    });

    res.json(m);
  })
);

export default router;
