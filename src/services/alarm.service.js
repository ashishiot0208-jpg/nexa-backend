import mongoose from 'mongoose';
import { Alarm, AlarmEvent } from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from './audit.service.js';
import { ensureProjectAccess } from '../middleware/auth.js';
import { severityRank } from '../utils/severity.js';
import { resolveApplicableAlarmPolicy } from './alarm-policy.service.js';

// =========================================================================
// CANONICAL ALARM LIFECYCLE (Phase C6A)
// Controlled States: OPEN -> ACKNOWLEDGED -> RESOLVED
// =========================================================================

export const CANONICAL_ALARM_CATEGORIES = [
  'ENGINEERING_SEVERITY',
  'MONITORING_HEALTH',
  'MEASUREMENT_QUALITY',
  'DEVICE_CONNECTIVITY',
  'GATEWAY_CONNECTIVITY'
];

export const CANONICAL_ALARM_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];

export function humanizeParameter(paramCode) {
  if (!paramCode) return 'Parameter';
  const map = {
    x_displacement: 'X displacement',
    y_displacement: 'Y displacement',
    z_displacement: 'Z displacement',
    temperature: 'Temperature',
    pore_pressure: 'Pore Pressure',
    pressure: 'Pressure',
    tilt_x: 'Tilt (X-axis)',
    tilt_y: 'Tilt (Y-axis)',
    vibration_rms: 'Vibration RMS',
    water_level: 'Water Level',
    crack_width: 'Crack Width',
    strain: 'Microstrain',
    voltage: 'Supply Voltage'
  };
  return map[paramCode.toLowerCase()] || paramCode.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Generate deterministic deduplication fingerprint for active alarms.
 */
export function computeAlarmFingerprint({ projectId, category, instrumentId, parameterCode, ruleId, deviceId, gatewayId }) {
  const parts = [
    'CANONICAL_V2',
    String(projectId),
    category || 'ENGINEERING_SEVERITY'
  ];
  if (instrumentId) parts.push(`INST:${instrumentId}`);
  if (parameterCode) parts.push(`PARAM:${parameterCode}`);
  if (ruleId) parts.push(`RULE:${ruleId}`);
  if (deviceId) parts.push(`DEV:${deviceId}`);
  if (gatewayId) parts.push(`GW:${gatewayId}`);
  return parts.join(':');
}

/**
 * Find existing active/unresolved alarm matching the fingerprint.
 */
export async function findActiveAlarm({ projectId, fingerprint, category, instrumentId, parameterCode, ruleId, deviceId, gatewayId }) {
  const fp = fingerprint || computeAlarmFingerprint({ projectId, category, instrumentId, parameterCode, ruleId, deviceId, gatewayId });
  return Alarm.findOne({
    projectId,
    fingerprint: fp,
    status: { $in: ['OPEN', 'ACKNOWLEDGED'] },
    lifecycleVersion: 2
  });
}

/**
 * Create a canonical Alarm record with full snapshot traceability.
 * Does NOT auto-trigger alarms on telemetry in C6A; system/service driven.
 */
export async function createAlarm({
  organizationId,
  projectId,
  category = 'ENGINEERING_SEVERITY',
  source,
  title,
  summary,
  reason,
  instrumentId,
  deviceId,
  gatewayId,
  parameterCode,
  engineeringSnapshot,
  healthSnapshot,
  qualitySnapshot,
  initialSeverity,
  alarmPolicyId,
  alarmPolicyVersion,
  actor,
  comment,
  emit = () => {}
}) {
  if (!organizationId || !projectId) {
    throw new ApiError(400, 'organizationId and projectId are required to create an alarm');
  }
  if (!title) {
    throw new ApiError(400, 'Alarm title is required');
  }

  // Deduplication check
  const fingerprint = computeAlarmFingerprint({
    projectId,
    category,
    instrumentId,
    parameterCode,
    ruleId: engineeringSnapshot?.ruleId,
    deviceId,
    gatewayId
  });

  const existingActive = await Alarm.findOne({
    projectId,
    fingerprint,
    status: { $in: ['OPEN', 'ACKNOWLEDGED'] },
    lifecycleVersion: 2
  });

  if (existingActive) {
    return { alarm: existingActive, isDuplicate: true };
  }

  const effectiveSev = initialSeverity || engineeringSnapshot?.severityLevel || 'S0';
  const legacyType = category === 'ENGINEERING_SEVERITY'
    ? 'ENGINEERING'
    : (category === 'MONITORING_HEALTH' ? 'MONITORING_HEALTH' : 'CONFIGURATION');

  const now = new Date();
  const effectivePolicyId = alarmPolicyId || engineeringSnapshot?.alarmPolicyId;
  const effectivePolicyVersion = alarmPolicyVersion || engineeringSnapshot?.alarmPolicyVersion;

  const alarm = await Alarm.create({
    organizationId,
    projectId,
    instrumentId,
    deviceId,
    gatewayId,
    category,
    source: source || category,
    type: legacyType,
    title,
    summary: summary || reason || title,
    reason: reason || summary,
    parameterCode,
    severity: effectiveSev,
    initialSeverity: effectiveSev,
    currentSeverity: effectiveSev,
    highestSeverity: effectiveSev,
    healthGrade: healthSnapshot?.healthGrade || 'H0',
    status: 'OPEN',
    state: 'TRIGGERED', // Legacy state compatibility
    lifecycleVersion: 2,
    triggeredAt: now,
    openedAt: now,
    fingerprint,
    engineeringSnapshot: engineeringSnapshot || undefined,
    currentEngineeringSnapshot: engineeringSnapshot || undefined,
    healthSnapshot: healthSnapshot || undefined,
    qualitySnapshot: qualitySnapshot || undefined,
    alarmPolicyId: effectivePolicyId || undefined,
    alarmPolicyVersion: effectivePolicyVersion || undefined,
    reasonCodes: reason ? [reason] : []
  });

  // Audit history event: CREATED
  await AlarmEvent.create({
    alarmId: alarm._id,
    projectId: alarm.projectId,
    actorType: actor?.actorType || 'SYSTEM',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType: 'CREATED',
    previousStatus: null,
    newStatus: 'OPEN',
    fromState: null,
    toState: 'TRIGGERED',
    comment: comment || 'Canonical alarm created',
    metadata: {
      category,
      severity: effectiveSev,
      fingerprint,
      alarmPolicyId: effectivePolicyId,
      alarmPolicyVersion: effectivePolicyVersion,
      ruleId: engineeringSnapshot?.ruleId,
      ruleVersion: engineeringSnapshot?.ruleVersion,
      evaluatedValue: engineeringSnapshot?.evaluatedValue,
      unit: engineeringSnapshot?.unit
    }
  });

  emit('alarm.created', {
    alarmId: alarm._id,
    projectId: alarm.projectId,
    category: alarm.category,
    status: alarm.status,
    severity: alarm.currentSeverity
  });

  return { alarm, isDuplicate: false };
}

/**
 * Acknowledge an OPEN alarm. Safe against double acknowledgment (idempotent).
 */
export async function acknowledgeAlarm({ alarmId, projectId, organizationId, user, userRole, comment, req, emit = () => {} }) {
  const role = userRole || req?.projectRole;
  if (role === 'VIEWER') {
    throw new ApiError(403, 'Viewer permission is read-only. Cannot modify alarms.');
  }

  const alarm = await Alarm.findOne({ _id: alarmId, projectId, organizationId });
  if (!alarm) {
    throw new ApiError(404, 'Alarm not found');
  }

  if (alarm.status === 'RESOLVED' || alarm.state === 'CLOSED') {
    throw new ApiError(409, 'Cannot acknowledge a resolved alarm');
  }

  // Idempotent safe double acknowledgment
  if (alarm.status === 'ACKNOWLEDGED') {
    return alarm;
  }

  if (alarm.status !== 'OPEN' && alarm.state !== 'TRIGGERED') {
    throw new ApiError(409, `Cannot acknowledge alarm in status '${alarm.status}'`);
  }

  const now = new Date();
  const userId = user?.userId || req?.auth?.userId;
  const userEmail = user?.email || req?.auth?.email;
  const userDisplayName = user?.displayName || req?.auth?.displayName;

  // Atomic state transition
  const updated = await Alarm.findOneAndUpdate(
    { _id: alarmId, projectId, organizationId, status: { $in: ['OPEN', 'TRIGGERED'] } },
    {
      $set: {
        status: 'ACKNOWLEDGED',
        state: 'ACKNOWLEDGED',
        acknowledgedAt: now,
        acknowledgedBy: userId,
        lastComment: comment || alarm.lastComment || 'Acknowledged'
      }
    },
    { new: true }
  );

  if (!updated) {
    // Check if another concurrent request already acknowledged it
    const recheck = await Alarm.findOne({ _id: alarmId, projectId, organizationId });
    if (recheck?.status === 'ACKNOWLEDGED') return recheck;
    throw new ApiError(409, 'Concurrent modification conflict while acknowledging alarm');
  }

  // Record audit history event
  await AlarmEvent.create({
    alarmId: updated._id,
    projectId: updated.projectId,
    actorType: 'USER',
    actorId: userId,
    actorEmail: userEmail,
    actorDisplayName: userDisplayName,
    eventType: 'ACKNOWLEDGED',
    previousStatus: 'OPEN',
    newStatus: 'ACKNOWLEDGED',
    fromState: alarm.state || 'TRIGGERED',
    toState: 'ACKNOWLEDGED',
    comment: comment || 'Alarm acknowledged'
  });

  if (req) {
    await audit({
      req,
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      action: 'ALARM_ACKNOWLEDGE',
      resourceType: 'Alarm',
      resourceId: updated._id,
      previousState: alarm.toObject(),
      newState: updated.toObject(),
      reason: comment
    });
  }

  emit('alarm.changed', {
    alarmId: updated._id,
    projectId: updated.projectId,
    fromStatus: 'OPEN',
    status: 'ACKNOWLEDGED',
    severity: updated.currentSeverity
  });

  return updated;
}

/**
 * Resolve an OPEN or ACKNOWLEDGED alarm. Terminal lifecycle state.
 */
export async function resolveAlarm({ alarmId, projectId, organizationId, user, userRole, comment, resolutionReason, req, emit = () => {} }) {
  const role = userRole || req?.projectRole;
  if (role === 'VIEWER') {
    throw new ApiError(403, 'Viewer permission is read-only. Cannot modify alarms.');
  }

  const alarm = await Alarm.findOne({ _id: alarmId, projectId, organizationId });
  if (!alarm) {
    throw new ApiError(404, 'Alarm not found');
  }

  if (alarm.status === 'RESOLVED' || alarm.state === 'CLOSED') {
    throw new ApiError(409, 'Alarm is already resolved');
  }

  const prevStatus = alarm.status || (alarm.state === 'TRIGGERED' ? 'OPEN' : alarm.state);
  const now = new Date();
  const userId = user?.userId || req?.auth?.userId;
  const userEmail = user?.email || req?.auth?.email;
  const userDisplayName = user?.displayName || req?.auth?.displayName;

  // Atomic state transition
  const updated = await Alarm.findOneAndUpdate(
    { _id: alarmId, projectId, organizationId, status: { $ne: 'RESOLVED' } },
    {
      $set: {
        status: 'RESOLVED',
        state: 'CLOSED', // Legacy state compatibility
        resolvedAt: now,
        resolvedBy: userId,
        resolutionReason: resolutionReason || 'RESOLVED',
        resolutionCode: resolutionReason || 'RESOLVED',
        lastComment: comment || alarm.lastComment || 'Resolved'
      },
      $unset: {
        fingerprint: '', // Release fingerprint so a new alarm can be triggered in the future if condition recurs
        activeKey: ''
      }
    },
    { new: true }
  );

  if (!updated) {
    throw new ApiError(409, 'Alarm is already resolved or could not be updated');
  }

  // Record audit history event
  await AlarmEvent.create({
    alarmId: updated._id,
    projectId: updated.projectId,
    actorType: 'USER',
    actorId: userId,
    actorEmail: userEmail,
    actorDisplayName: userDisplayName,
    eventType: 'RESOLVED',
    previousStatus: prevStatus,
    newStatus: 'RESOLVED',
    fromState: alarm.state,
    toState: 'CLOSED',
    comment: comment || 'Alarm resolved',
    metadata: {
      resolutionReason: resolutionReason || 'RESOLVED'
    }
  });

  if (req) {
    await audit({
      req,
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      action: 'ALARM_RESOLVE',
      resourceType: 'Alarm',
      resourceId: updated._id,
      previousState: alarm.toObject(),
      newState: updated.toObject(),
      reason: comment
    });
  }

  emit('alarm.changed', {
    alarmId: updated._id,
    projectId: updated.projectId,
    fromStatus: prevStatus,
    status: 'RESOLVED',
    severity: updated.currentSeverity
  });

  return updated;
}

/**
 * Escalate severity on an active alarm without creating duplicate records.
 */
export async function escalateAlarmSeverity({ alarmId, projectId, organizationId, newSeverity, newSnapshot, actor, comment, emit = () => {} }) {
  const alarm = await Alarm.findOne({ _id: alarmId, projectId, organizationId });
  if (!alarm) throw new ApiError(404, 'Alarm not found');
  if (alarm.status === 'RESOLVED' || alarm.state === 'CLOSED') {
    throw new ApiError(409, 'Cannot escalate a resolved alarm');
  }

  const prevSeverity = alarm.currentSeverity || alarm.severity;
  const prevHighest = alarm.highestSeverity || prevSeverity;
  const newHighest = severityRank(newSeverity) > severityRank(prevHighest) ? newSeverity : prevHighest;

  alarm.currentSeverity = newSeverity;
  alarm.severity = newSeverity;
  alarm.highestSeverity = newHighest;
  // Preserve immutable engineeringSnapshot (Initial Trigger Snapshot); update currentEngineeringSnapshot
  if (newSnapshot) {
    alarm.currentEngineeringSnapshot = { ...(alarm.currentEngineeringSnapshot || alarm.engineeringSnapshot), ...newSnapshot };
    if (newSnapshot.alarmPolicyId) alarm.alarmPolicyId = newSnapshot.alarmPolicyId;
    if (newSnapshot.alarmPolicyVersion) alarm.alarmPolicyVersion = newSnapshot.alarmPolicyVersion;
  }
  await alarm.save();

  await AlarmEvent.create({
    alarmId: alarm._id,
    projectId: alarm.projectId,
    actorType: actor?.actorType || 'SYSTEM',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType: 'ESCALATED',
    previousStatus: alarm.status,
    newStatus: alarm.status,
    comment: comment || `Severity escalated from ${prevSeverity} to ${newSeverity}`,
    metadata: {
      previousSeverity: prevSeverity,
      newSeverity,
      highestSeverity: newHighest,
      observedAt: newSnapshot?.observedAt,
      ruleId: newSnapshot?.ruleId,
      ruleVersion: newSnapshot?.ruleVersion,
      evaluatedValue: newSnapshot?.evaluatedValue,
      unit: newSnapshot?.unit,
      alarmPolicyId: newSnapshot?.alarmPolicyId || alarm.alarmPolicyId,
      alarmPolicyVersion: newSnapshot?.alarmPolicyVersion || alarm.alarmPolicyVersion
    }
  });

  emit('alarm.escalated', {
    alarmId: alarm._id,
    projectId: alarm.projectId,
    previousSeverity: prevSeverity,
    currentSeverity: newSeverity,
    highestSeverity: newHighest
  });

  return alarm;
}

/**
 * Get alarm details with full lifecycle history.
 */
export async function getAlarm({ alarmId, projectId, organizationId }) {
  let query = { projectId, organizationId };
  if (mongoose.Types.ObjectId.isValid(alarmId)) {
    query._id = alarmId;
  } else if (typeof alarmId === 'string' && (alarmId.startsWith('ALM-') || alarmId.length === 6)) {
    const suffix = alarmId.replace(/^ALM-/i, '').toLowerCase();
    const candidates = await Alarm.find({ projectId, organizationId }).lean();
    const matched = candidates.find(c => c._id.toString().toLowerCase().endsWith(suffix) || c.code === alarmId || c.alarmCode === alarmId);
    if (matched) {
      query._id = matched._id;
    } else {
      throw new ApiError(404, 'Alarm not found');
    }
  } else {
    query._id = alarmId;
  }

  const alarm = await Alarm.findOne(query)
    .populate('instrumentId', 'code name')
    .populate('acknowledgedBy', 'displayName email')
    .populate('resolvedBy', 'displayName email')
    .populate('engineeringSnapshot.ruleId', 'name code version')
    .populate('currentEngineeringSnapshot.ruleId', 'name code version')
    .lean();

  if (!alarm) {
    throw new ApiError(404, 'Alarm not found');
  }

  const events = await AlarmEvent.find({ alarmId: alarm._id })
    .sort({ createdAt: 1 })
    .populate('actorId', 'displayName email')
    .lean();

  return { alarm, events };
}

/**
 * List alarms with clean project-scoped filters.
 */
export async function listAlarms({
  projectId,
  organizationId,
  status,
  category,
  instrumentId,
  severity,
  lifecycleVersion,
  includeLegacy = false,
  limit = 100,
  skip = 0
}) {
  const query = { projectId, organizationId };

  if (lifecycleVersion !== undefined) {
    query.lifecycleVersion = Number(lifecycleVersion);
  } else if (!includeLegacy) {
    // Default to canonical lifecycle alarms unless includeLegacy=true requested
    query.lifecycleVersion = 2;
  }

  if (status) {
    const statuses = String(status).split(',');
    if (includeLegacy) {
      query.$or = [
        { status: { $in: statuses } },
        { state: { $in: statuses } }
      ];
    } else {
      query.status = { $in: statuses };
    }
  }

  if (category) {
    query.category = category;
  }

  if (instrumentId) {
    query.instrumentId = instrumentId;
  }

  if (severity) {
    query.$or = [
      { currentSeverity: severity },
      { severity: severity }
    ];
  }

  const parsedLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const parsedSkip = Math.max(0, Number(skip) || 0);

  const alarms = await Alarm.find(query)
    .sort({ triggeredAt: -1, createdAt: -1 })
    .skip(parsedSkip)
    .limit(parsedLimit)
    .populate('instrumentId', 'code name')
    .lean();

  // Mark legacy indicator for clean caller identification
  return alarms.map((a) => ({
    ...a,
    isLegacy: !a.lifecycleVersion || a.lifecycleVersion < 2
  }));
}

// =========================================================================
// LEGACY TRANSITION SUPPORT (Preserved for compatibility)
// =========================================================================

const allowedLegacy = {
  TRIGGERED: ['ACKNOWLEDGED', 'ESCALATED'],
  ACKNOWLEDGED: ['UNDER_INVESTIGATION', 'ESCALATED'],
  UNDER_INVESTIGATION: ['ACTION_IN_PROGRESS', 'ESCALATED'],
  ACTION_IN_PROGRESS: ['CONDITION_NORMALIZED', 'ESCALATED'],
  ESCALATED: ['ACKNOWLEDGED', 'UNDER_INVESTIGATION', 'ACTION_IN_PROGRESS', 'CONDITION_NORMALIZED'],
  CONDITION_NORMALIZED: ['CLOSED', 'TRIGGERED'],
  CLOSED: ['TRIGGERED']
};

export async function transitionAlarm({ alarmId, toState, comment, actionCode, resolutionCode, ownerId, req, emit = () => {} }) {
  const alarm = await Alarm.findById(alarmId);
  if (!alarm) throw new ApiError(404, 'Alarm not found');
  await ensureProjectAccess(req, alarm.projectId);
  if (!(allowedLegacy[alarm.state] || []).includes(toState)) throw new ApiError(409, `Transition ${alarm.state} -> ${toState} is not allowed`);
  if (['ACKNOWLEDGED', 'UNDER_INVESTIGATION', 'ACTION_IN_PROGRESS', 'CLOSED'].includes(toState) && !comment) throw new ApiError(400, 'Comment is required for this transition');
  const before = alarm.toObject();
  const from = alarm.state;
  alarm.state = toState;
  alarm.lastComment = comment || alarm.lastComment;
  if (ownerId) alarm.ownerId = ownerId;
  if (toState === 'ACKNOWLEDGED') alarm.acknowledgedAt = new Date();
  if (toState === 'CONDITION_NORMALIZED') alarm.normalizedAt = new Date();
  if (toState === 'CLOSED') { alarm.closedAt = new Date(); alarm.resolutionCode = resolutionCode || 'RESOLVED'; alarm.activeKey = undefined; }
  if (toState === 'TRIGGERED' && from === 'CLOSED') { alarm.closedAt = undefined; alarm.normalizedAt = undefined; alarm.activeKey = `${alarm.type}:${alarm.projectId}:${alarm.instrumentId || 'PROJECT'}`; }
  await alarm.save();
  await AlarmEvent.create({ alarmId: alarm._id, projectId: alarm.projectId, actorType: 'USER', actorId: req.auth.userId, eventType: 'STATE_TRANSITION', fromState: from, toState, comment, actionCode, metadata: { resolutionCode } });
  await audit({ req, organizationId: alarm.organizationId, projectId: alarm.projectId, action: 'ALARM_TRANSITION', resourceType: 'Alarm', resourceId: alarm._id, previousState: before, newState: alarm.toObject(), reason: comment });
  emit('alarm.changed', { alarmId: alarm._id, projectId: alarm.projectId, fromState: from, state: toState, severity: alarm.severity, healthGrade: alarm.healthGrade });
  return alarm;
}

/**
 * PHASE C6C — CANONICAL ALARM TRIGGER POLICY EVALUATION
 * Consumes canonical severity evaluation from severity.service.js.
 * Connects engineering severity to canonical alarm lifecycle through explicit policy.
 *
 * S0/NOT_EVALUATED -> No alarm.
 * No policy / Inactive policy -> No alarm.
 * Trigger level matched -> Create OPEN alarm or escalate existing active alarm.
 * Deduplication via deterministic fingerprint.
 */
export async function evaluateAlarmTriggerForSeverity({
  project,
  instrument,
  derivedReading,
  severityResult,
  emit = () => {}
}) {
  if (!severityResult || !severityResult.evaluated) {
    return { triggered: false, reason: severityResult?.reason || 'NOT_EVALUATED' };
  }

  const level = severityResult.level;
  if (!level || level === 'NOT_EVALUATED' || level === 'S0') {
    return { triggered: false, reason: 'SEVERITY_LEVEL_EXCLUDED' };
  }

  const projectId = project?._id || derivedReading.projectId;
  const instrumentId = instrument?._id || derivedReading.instrumentId;
  const parameterCode = derivedReading.parameterCode;

  // 1. Resolve applicable active policy
  const policy = await resolveApplicableAlarmPolicy({
    projectId,
    category: 'ENGINEERING_SEVERITY',
    instrumentId,
    catalogCode: instrument?.catalogCode,
    parameterCode
  });

  if (!policy) {
    return { triggered: false, reason: 'NO_ACTIVE_POLICY' };
  }

  // 2. Check triggerLevels
  if (!Array.isArray(policy.triggerLevels) || !policy.triggerLevels.includes(level)) {
    return { triggered: false, reason: 'LEVEL_NOT_IN_POLICY', policyId: policy._id, level };
  }

  console.log(`[alarm.service] Policy match: '${policy.name}' (v${policy.version}) on ${level} for instrument ${instrument?.code || instrumentId}`);

  // 3. Deterministic active fingerprint
  const fingerprint = computeAlarmFingerprint({
    projectId,
    category: 'ENGINEERING_SEVERITY',
    instrumentId,
    parameterCode,
    ruleId: severityResult.ruleId
  });

  // 4. Check for active canonical alarm
  const existingActive = await findActiveAlarm({
    projectId,
    fingerprint
  });

  if (!existingActive) {
    // 5. Create new canonical OPEN Alarm
    const instCode = instrument?.code || 'Instrument';
    const paramTitle = humanizeParameter(parameterCode);
    const title = `${instCode} · ${paramTitle}`;
    const summary = `Engineering severity evaluated to ${level} for ${parameterCode} (${severityResult.evaluatedValue} ${severityResult.unit})`;

    const result = await createAlarm({
      organizationId: project?.organizationId || derivedReading.organizationId,
      projectId,
      category: 'ENGINEERING_SEVERITY',
      source: 'ENGINEERING_SEVERITY',
      title,
      summary,
      reason: severityResult.reason || `THRESHOLD_${level}_EXCEEDED`,
      instrumentId,
      parameterCode,
      initialSeverity: level,
      currentSeverity: level,
      highestSeverity: level,
      alarmPolicyId: policy._id,
      alarmPolicyVersion: policy.version,
      engineeringSnapshot: {
        severityLevel: level,
        ruleId: severityResult.ruleId,
        ruleVersion: severityResult.ruleVersion,
        metric: severityResult.metric,
        evaluatedValue: severityResult.evaluatedValue,
        unit: severityResult.unit,
        observedAt: derivedReading.observedAt,
        severityEvaluatedAt: severityResult.evaluatedAt,
        reason: severityResult.reason,
        alarmPolicyId: policy._id,
        alarmPolicyVersion: policy.version
      },
      actor: {
        actorType: 'SYSTEM',
        displayName: 'Engineering Severity Engine'
      },
      comment: `Canonical alarm triggered by policy '${policy.name}' (v${policy.version}) on ${level}`,
      emit
    });

    console.log(`[alarm.service] Canonical alarm created: ${result.alarm._id} (${level})`);
    return { triggered: true, action: 'CREATED', alarm: result.alarm, policy };
  }

  // Active alarm exists: check escalation or duplicate
  const curRank = severityRank(existingActive.currentSeverity || existingActive.severity || 'S0');
  const newRank = severityRank(level);

  if (newRank > curRank) {
    // Higher severity -> Escalate existing alarm
    const escalated = await escalateAlarmSeverity({
      alarmId: existingActive._id,
      projectId,
      organizationId: existingActive.organizationId,
      newSeverity: level,
      newSnapshot: {
        severityLevel: level,
        ruleId: severityResult.ruleId,
        ruleVersion: severityResult.ruleVersion,
        metric: severityResult.metric,
        evaluatedValue: severityResult.evaluatedValue,
        unit: severityResult.unit,
        observedAt: derivedReading.observedAt,
        severityEvaluatedAt: severityResult.evaluatedAt,
        reason: severityResult.reason,
        alarmPolicyId: policy._id,
        alarmPolicyVersion: policy.version
      },
      actor: {
        actorType: 'SYSTEM',
        displayName: 'Engineering Severity Engine'
      },
      comment: `Severity escalated from ${existingActive.currentSeverity} to ${level}`,
      emit
    });

    console.log(`[alarm.service] Canonical alarm escalated: ${escalated._id} to ${level}`);
    return { triggered: true, action: 'ESCALATED', alarm: escalated, policy };
  }

  // Same or lower severity level: duplicate suppressed, no auto-resolve
  console.log(`[alarm.service] Duplicate suppressed for active alarm ${existingActive._id} (${level})`);
  return { triggered: false, action: 'DUPLICATE_SUPPRESSED', alarm: existingActive, policy };
}

