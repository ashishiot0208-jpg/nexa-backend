import { Router } from 'express';
import { EngineeringSeverityRule, validateRuleThresholds, Project, Instrument } from '../models/index.js';
import { requireAuth, requireProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /projects/:projectId/severity-rules
 * List all engineering severity rules for a project.
 */
router.get('/projects/:projectId/severity-rules', requireProjectAccess, asyncHandler(async (req, res) => {
  const query = { projectId: req.params.projectId };
  if (req.query.status) query.status = String(req.query.status).toUpperCase();
  if (req.query.parameterCode) query.parameterCode = String(req.query.parameterCode);
  if (req.query.instrumentId) query.instrumentId = req.query.instrumentId;

  const rules = await EngineeringSeverityRule.find(query).sort({ parameterCode: 1, version: -1, createdAt: -1 }).lean();
  res.json(rules);
}));

/**
 * POST /projects/:projectId/severity-rules
 * Create an engineering severity rule with monotonic threshold validation.
 */
router.post('/projects/:projectId/severity-rules', requireProjectAccess, asyncHandler(async (req, res) => {
  const {
    name,
    code,
    parameterCode,
    catalogCode,
    instrumentId,
    metric,
    mode,
    unit,
    thresholds,
    status = 'ACTIVE'
  } = req.body;

  if (!name || !name.trim()) throw new ApiError(400, 'Rule name is required');
  if (!parameterCode || !parameterCode.trim()) throw new ApiError(400, 'parameterCode is required');
  if (!metric || !['engineeringValue', 'deltaFromBaseline', 'ratePerHour'].includes(metric)) {
    throw new ApiError(400, 'metric must be one of: engineeringValue, deltaFromBaseline, ratePerHour');
  }
  if (!mode || !['INCREASING', 'DECREASING', 'ABSOLUTE'].includes(mode)) {
    throw new ApiError(400, 'mode must be one of: INCREASING, DECREASING, ABSOLUTE');
  }
  if (!unit || !unit.trim()) throw new ApiError(400, 'unit is required');

  // Enforce monotonic threshold ordering
  const validation = validateRuleThresholds({ mode, thresholds });
  if (!validation.valid) {
    throw new ApiError(400, `Threshold validation error: ${validation.message}`);
  }

  // Verify instrument if provided
  if (instrumentId) {
    const inst = await Instrument.findOne({ _id: instrumentId, projectId: req.params.projectId }).lean();
    if (!inst) throw new ApiError(404, `Instrument ${instrumentId} not found in this project`);
  }

  // Conflict check: Avoid conflicting active rules for the exact same scope
  if (status === 'ACTIVE') {
    const existingConflict = await EngineeringSeverityRule.findOne({
      projectId: req.params.projectId,
      parameterCode,
      catalogCode: catalogCode || null,
      instrumentId: instrumentId || null,
      status: 'ACTIVE'
    }).lean();

    if (existingConflict) {
      throw new ApiError(409, `An active engineering rule ('${existingConflict.name}' / ${existingConflict.code}) already exists for this scope`);
    }
  }

  const generatedCode = code?.trim() || `SEV-${parameterCode.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  const rule = await EngineeringSeverityRule.create({
    organizationId: req.auth.organizationId,
    projectId: req.params.projectId,
    name: name.trim(),
    code: generatedCode,
    status: status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    parameterCode: parameterCode.trim(),
    catalogCode: catalogCode ? catalogCode.trim() : null,
    instrumentId: instrumentId || null,
    metric,
    mode,
    unit: unit.trim(),
    thresholds: {
      s1: thresholds.s1 !== undefined && thresholds.s1 !== null ? Number(thresholds.s1) : null,
      s2: thresholds.s2 !== undefined && thresholds.s2 !== null ? Number(thresholds.s2) : null,
      s3: thresholds.s3 !== undefined && thresholds.s3 !== null ? Number(thresholds.s3) : null,
      s4: thresholds.s4 !== undefined && thresholds.s4 !== null ? Number(thresholds.s4) : null
    },
    version: 1,
    createdBy: req.auth.userId,
    updatedBy: req.auth.userId
  });

  await audit({
    req,
    projectId: req.params.projectId,
    action: 'SEVERITY_RULE_CREATED',
    resourceType: 'EngineeringSeverityRule',
    resourceId: rule._id,
    newState: rule.toObject()
  });

  res.status(201).json(rule);
}));

/**
 * GET /projects/:projectId/severity-rules/:id
 * Retrieve a specific severity rule by ID.
 */
router.get('/projects/:projectId/severity-rules/:id', requireProjectAccess, asyncHandler(async (req, res) => {
  const rule = await EngineeringSeverityRule.findOne({
    _id: req.params.id,
    projectId: req.params.projectId
  }).lean();

  if (!rule) throw new ApiError(404, 'Severity rule not found');
  res.json(rule);
}));

/**
 * PUT /projects/:projectId/severity-rules/:id
 * Update rule and increment version when thresholds, metric, mode, or unit change.
 */
router.put('/projects/:projectId/severity-rules/:id', requireProjectAccess, asyncHandler(async (req, res) => {
  const rule = await EngineeringSeverityRule.findOne({
    _id: req.params.id,
    projectId: req.params.projectId
  });
  if (!rule) throw new ApiError(404, 'Severity rule not found');

  const {
    name,
    metric = rule.metric,
    mode = rule.mode,
    unit = rule.unit,
    thresholds = rule.thresholds,
    status = rule.status
  } = req.body;

  if (name) rule.name = name.trim();
  if (req.body.parameterCode && req.body.parameterCode !== rule.parameterCode) {
    throw new ApiError(400, 'Cannot change parameterCode of an existing rule; create a new rule instead');
  }

  // Validate monotonic thresholds
  const validation = validateRuleThresholds({ mode, thresholds });
  if (!validation.valid) {
    throw new ApiError(400, `Threshold validation error: ${validation.message}`);
  }

  // Detect if engineering thresholds or evaluation parameters changed -> version increment
  const prevS = rule.thresholds || {};
  const thresholdsChanged =
    Number(thresholds.s1) !== Number(prevS.s1) ||
    Number(thresholds.s2) !== Number(prevS.s2) ||
    Number(thresholds.s3) !== Number(prevS.s3) ||
    Number(thresholds.s4) !== Number(prevS.s4) ||
    metric !== rule.metric ||
    mode !== rule.mode ||
    unit !== rule.unit;

  if (thresholdsChanged) {
    rule.version = (rule.version || 1) + 1;
  }

  rule.metric = metric;
  rule.mode = mode;
  rule.unit = unit.trim();
  rule.thresholds = {
    s1: thresholds.s1 !== undefined && thresholds.s1 !== null ? Number(thresholds.s1) : null,
    s2: thresholds.s2 !== undefined && thresholds.s2 !== null ? Number(thresholds.s2) : null,
    s3: thresholds.s3 !== undefined && thresholds.s3 !== null ? Number(thresholds.s3) : null,
    s4: thresholds.s4 !== undefined && thresholds.s4 !== null ? Number(thresholds.s4) : null
  };
  rule.status = status;
  rule.updatedBy = req.auth.userId;

  await rule.save();

  await audit({
    req,
    projectId: req.params.projectId,
    action: 'SEVERITY_RULE_UPDATED',
    resourceType: 'EngineeringSeverityRule',
    resourceId: rule._id,
    newState: rule.toObject()
  });

  res.json(rule);
}));

/**
 * PATCH /projects/:projectId/severity-rules/:id/status
 * Activate or deactivate a rule.
 */
router.patch('/projects/:projectId/severity-rules/:id/status', requireProjectAccess, asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw new ApiError(400, 'status must be ACTIVE or INACTIVE');
  }

  const rule = await EngineeringSeverityRule.findOne({
    _id: req.params.id,
    projectId: req.params.projectId
  });
  if (!rule) throw new ApiError(404, 'Severity rule not found');

  if (status === 'ACTIVE' && rule.status !== 'ACTIVE') {
    const existingConflict = await EngineeringSeverityRule.findOne({
      _id: { $ne: rule._id },
      projectId: req.params.projectId,
      parameterCode: rule.parameterCode,
      catalogCode: rule.catalogCode || null,
      instrumentId: rule.instrumentId || null,
      status: 'ACTIVE'
    }).lean();

    if (existingConflict) {
      throw new ApiError(409, `Cannot activate rule: conflicting active rule '${existingConflict.name}' (${existingConflict.code}) already exists`);
    }
  }

  rule.status = status;
  rule.updatedBy = req.auth.userId;
  await rule.save();

  await audit({
    req,
    projectId: req.params.projectId,
    action: 'SEVERITY_RULE_STATUS_CHANGED',
    resourceType: 'EngineeringSeverityRule',
    resourceId: rule._id,
    newState: { status: rule.status }
  });

  res.json(rule);
}));

/**
 * DELETE /projects/:projectId/severity-rules/:id
 * Deactivates or removes a severity rule.
 */
router.delete('/projects/:projectId/severity-rules/:id', requireProjectAccess, asyncHandler(async (req, res) => {
  const rule = await EngineeringSeverityRule.findOne({
    _id: req.params.id,
    projectId: req.params.projectId
  });
  if (!rule) throw new ApiError(404, 'Severity rule not found');

  rule.status = 'INACTIVE';
  rule.updatedBy = req.auth.userId;
  await rule.save();

  await audit({
    req,
    projectId: req.params.projectId,
    action: 'SEVERITY_RULE_DEACTIVATED',
    resourceType: 'EngineeringSeverityRule',
    resourceId: rule._id
  });

  res.json({ message: 'Rule deactivated successfully', ruleId: rule._id });
}));

export default router;
