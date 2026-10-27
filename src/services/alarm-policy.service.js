import { AlarmTriggerPolicy, Instrument, Project } from '../models/index.js';
import { ApiError } from '../utils/api-error.js';

/**
 * Resolves the single applicable active Alarm Trigger Policy for a given scope
 * according to deterministic precedence:
 * 1. Instrument + parameter-specific active policy
 * 2. Catalogue + parameter active policy
 * 3. Project parameter active policy (generic across project)
 * 4. Project-wide engineering severity policy (generic across all parameters)
 * 5. null (No active policy -> NO ALARM ACTION)
 */
export async function resolveApplicableAlarmPolicy({
  projectId,
  category = 'ENGINEERING_SEVERITY',
  instrumentId = null,
  catalogCode = null,
  parameterCode = null
}) {
  if (!projectId) return null;

  // 1. Instrument + parameter-specific active policy
  if (instrumentId && parameterCode) {
    const instPolicy = await AlarmTriggerPolicy.findOne({
      projectId,
      category,
      scope: 'INSTRUMENT',
      instrumentId,
      parameterCode,
      status: 'ACTIVE'
    }).lean();
    if (instPolicy) return instPolicy;
  }

  // 2. Catalogue + parameter active policy
  if (catalogCode && parameterCode) {
    const catPolicy = await AlarmTriggerPolicy.findOne({
      projectId,
      category,
      scope: 'CATALOGUE',
      catalogCode,
      parameterCode,
      status: 'ACTIVE'
    }).lean();
    if (catPolicy) return catPolicy;
  }

  // 3. Project parameter active policy
  if (parameterCode) {
    const paramPolicy = await AlarmTriggerPolicy.findOne({
      projectId,
      category,
      scope: 'PARAMETER',
      parameterCode,
      instrumentId: null,
      catalogCode: null,
      status: 'ACTIVE'
    }).lean();
    if (paramPolicy) return paramPolicy;
  }

  // 4. Project-wide engineering severity active policy
  const projPolicy = await AlarmTriggerPolicy.findOne({
    projectId,
    category,
    scope: 'PROJECT',
    instrumentId: null,
    catalogCode: null,
    parameterCode: null,
    status: 'ACTIVE'
  }).lean();
  if (projPolicy) return projPolicy;

  // 5. No applicable active policy -> NO ALARM ACTION
  return null;
}

/**
 * List alarm trigger policies for a project.
 */
export async function listAlarmPolicies({ projectId, status, category, scope }) {
  const query = { projectId };
  if (status) query.status = status.toUpperCase();
  if (category) query.category = category;
  if (scope) query.scope = scope.toUpperCase();

  return AlarmTriggerPolicy.find(query)
    .populate('instrumentId', 'code name')
    .sort({ scope: 1, parameterCode: 1, version: -1, createdAt: -1 })
    .lean();
}

/**
 * Get single alarm trigger policy by ID.
 */
export async function getAlarmPolicy({ policyId, projectId }) {
  const policy = await AlarmTriggerPolicy.findOne({ _id: policyId, projectId })
    .populate('instrumentId', 'code name')
    .lean();
  if (!policy) throw new ApiError(404, 'Alarm trigger policy not found');
  return policy;
}

/**
 * Create a new Alarm Trigger Policy.
 */
export async function createAlarmPolicy({
  organizationId,
  projectId,
  name,
  code,
  category = 'ENGINEERING_SEVERITY',
  scope = 'PROJECT',
  instrumentId = null,
  catalogCode = null,
  parameterCode = null,
  triggerLevels = ['S2', 'S3', 'S4'],
  status = 'INACTIVE',
  user = null
}) {
  if (!name || !name.trim()) throw new ApiError(400, 'Policy name is required');
  if (!projectId) throw new ApiError(400, 'projectId is required');

  const normalizedScope = scope.toUpperCase();
  if (!['INSTRUMENT', 'CATALOGUE', 'PARAMETER', 'PROJECT'].includes(normalizedScope)) {
    throw new ApiError(400, 'Invalid policy scope');
  }

  if (normalizedScope === 'INSTRUMENT' && (!instrumentId || !parameterCode)) {
    throw new ApiError(400, 'instrumentId and parameterCode are required for INSTRUMENT scope');
  }
  if (normalizedScope === 'CATALOGUE' && (!catalogCode || !parameterCode)) {
    throw new ApiError(400, 'catalogCode and parameterCode are required for CATALOGUE scope');
  }
  if (normalizedScope === 'PARAMETER' && !parameterCode) {
    throw new ApiError(400, 'parameterCode is required for PARAMETER scope');
  }

  if (!Array.isArray(triggerLevels) || triggerLevels.length === 0) {
    throw new ApiError(400, 'At least one triggerLevel (e.g. S2, S3, S4) must be specified');
  }
  const validLevels = ['S1', 'S2', 'S3', 'S4'];
  for (const lvl of triggerLevels) {
    if (!validLevels.includes(lvl)) {
      throw new ApiError(400, `Invalid triggerLevel: '${lvl}'. Must be one of: S1, S2, S3, S4`);
    }
  }

  if (instrumentId) {
    const inst = await Instrument.findOne({ _id: instrumentId, projectId });
    if (!inst) throw new ApiError(404, `Instrument '${instrumentId}' not found in project`);
  }

  const policy = await AlarmTriggerPolicy.create({
    organizationId,
    projectId,
    name: name.trim(),
    code: code || `POL-${Date.now().toString(36).toUpperCase()}`,
    category,
    scope: normalizedScope,
    instrumentId: normalizedScope === 'INSTRUMENT' ? instrumentId : null,
    catalogCode: normalizedScope === 'CATALOGUE' ? catalogCode : null,
    parameterCode: ['INSTRUMENT', 'CATALOGUE', 'PARAMETER'].includes(normalizedScope) ? parameterCode : null,
    triggerLevels: [...new Set(triggerLevels)],
    status: status.toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
    version: 1,
    createdBy: user?.userId || user?._id,
    updatedBy: user?.userId || user?._id
  });

  return policy;
}

/**
 * Update an existing Alarm Trigger Policy (increments version).
 */
export async function updateAlarmPolicy({ policyId, projectId, organizationId, updates, user }) {
  const policy = await AlarmTriggerPolicy.findOne({ _id: policyId, projectId });
  if (!policy) throw new ApiError(404, 'Alarm trigger policy not found');

  const allowedUpdates = ['name', 'triggerLevels', 'status', 'instrumentId', 'catalogCode', 'parameterCode', 'scope'];
  let modified = false;

  for (const key of allowedUpdates) {
    if (updates[key] !== undefined) {
      if (key === 'triggerLevels') {
        const validLevels = ['S1', 'S2', 'S3', 'S4'];
        for (const lvl of updates.triggerLevels) {
          if (!validLevels.includes(lvl)) throw new ApiError(400, `Invalid triggerLevel: '${lvl}'`);
        }
        policy.triggerLevels = [...new Set(updates.triggerLevels)];
        modified = true;
      } else if (key === 'status') {
        policy.status = String(updates.status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
        modified = true;
      } else {
        policy[key] = updates[key];
        modified = true;
      }
    }
  }

  if (modified) {
    policy.version += 1;
    policy.updatedBy = user?.userId || user?._id;
    await policy.save();
  }

  return policy;
}

/**
 * Toggle policy status (ACTIVE / INACTIVE).
 */
export async function setAlarmPolicyStatus({ policyId, projectId, status, user }) {
  const policy = await AlarmTriggerPolicy.findOne({ _id: policyId, projectId });
  if (!policy) throw new ApiError(404, 'Alarm trigger policy not found');

  const newStatus = String(status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
  policy.status = newStatus;
  policy.updatedBy = user?.userId || user?._id;
  await policy.save();

  return policy;
}
