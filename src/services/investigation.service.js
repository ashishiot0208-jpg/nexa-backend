import mongoose from 'mongoose';
import {
  Investigation,
  InvestigationEvent,
  InvestigationNote,
  Alarm,
  ProjectMember,
  OrganizationMember,
  User
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from './audit.service.js';

/**
 * Validate that an assignee has access to the target project.
 */
async function validateProjectUserAccess({ projectId, organizationId, userId }) {
  if (!userId) return null;
  const projectMember = await ProjectMember.findOne({ projectId, userId, status: 'ACTIVE' }).lean();
  if (projectMember) return projectMember;

  const orgAdmin = await OrganizationMember.findOne({
    organizationId,
    userId,
    organizationRole: 'ADMINISTRATOR',
    status: 'ACTIVE'
  }).lean();

  if (orgAdmin) return { role: 'ADMINISTRATOR', userId };

  throw new ApiError(400, 'Assigned user does not belong to or have access to this project');
}

/**
 * Resolve Investigation query by ObjectId or readable investigationCode.
 */
function buildInvestigationQuery({ investigationId, projectId, organizationId }) {
  const query = { projectId, organizationId };
  if (mongoose.Types.ObjectId.isValid(investigationId)) {
    query._id = investigationId;
  } else {
    query.investigationCode = String(investigationId).trim();
  }
  return query;
}

/**
 * Create a canonical project-scoped Investigation.
 */
export async function createInvestigation({
  organizationId,
  projectId,
  title,
  description = '',
  alarmId,
  instrumentId,
  deviceId,
  gatewayId,
  parameterCode,
  category,
  source,
  priority = 'MEDIUM',
  assignedTo,
  actor,
  comment,
  emit = () => {}
}) {
  if (!organizationId || !projectId) {
    throw new ApiError(400, 'organizationId and projectId are required');
  }
  if (!title || !title.trim()) {
    throw new ApiError(400, 'Investigation title is required');
  }

  let linkedAlarm = null;
  let alarmSnapshot = null;

  if (alarmId) {
    linkedAlarm = await Alarm.findOne({ _id: alarmId, projectId, organizationId });
    if (!linkedAlarm) {
      throw new ApiError(404, 'Alarm not found');
    }

    if (linkedAlarm.lifecycleVersion !== 2) {
      throw new ApiError(400, 'Investigations can only be linked to canonical alarms (lifecycleVersion: 2)');
    }

    // Duplication control: Only ONE active Investigation (OPEN / IN_PROGRESS) per canonical Alarm
    const existingActive = await Investigation.findOne({
      projectId,
      alarmId: linkedAlarm._id,
      status: { $in: ['OPEN', 'IN_PROGRESS'] }
    });

    if (existingActive) {
      throw new ApiError(409, `An active investigation (${existingActive.investigationCode || existingActive._id}) already exists for this alarm`);
    }

    alarmSnapshot = {
      alarmId: linkedAlarm._id,
      title: linkedAlarm.title,
      category: linkedAlarm.category,
      initialSeverity: linkedAlarm.initialSeverity || linkedAlarm.severity,
      currentSeverity: linkedAlarm.currentSeverity || linkedAlarm.severity,
      highestSeverity: linkedAlarm.highestSeverity || linkedAlarm.severity,
      parameterCode: linkedAlarm.parameterCode,
      triggeredAt: linkedAlarm.triggeredAt || linkedAlarm.openedAt,
      status: linkedAlarm.status
    };

    // Infer missing geotechnical linkages from alarm if not explicitly supplied
    instrumentId = instrumentId || linkedAlarm.instrumentId;
    deviceId = deviceId || linkedAlarm.deviceId;
    gatewayId = gatewayId || linkedAlarm.gatewayId;
    parameterCode = parameterCode || linkedAlarm.parameterCode;
    category = category || linkedAlarm.category;
    source = source || linkedAlarm.source || 'ALARM';
  }

  // Validate assignee if provided at creation
  if (assignedTo) {
    await validateProjectUserAccess({ projectId, organizationId, userId: assignedTo });
  }

  const investigation = await Investigation.create({
    organizationId,
    projectId,
    title: title.trim(),
    description: description ? description.trim() : '',
    status: 'OPEN',
    alarmId: linkedAlarm?._id,
    alarmSnapshot: alarmSnapshot || undefined,
    instrumentId: instrumentId || undefined,
    deviceId: deviceId || undefined,
    gatewayId: gatewayId || undefined,
    parameterCode: parameterCode || undefined,
    category: category || undefined,
    source: source || 'MANUAL',
    priority: priority || 'MEDIUM',
    assignedTo: assignedTo || undefined,
    assignedAt: assignedTo ? new Date() : undefined,
    createdBy: actor?.userId || actor?.actorId,
    lifecycleVersion: 1
  });

  // Audit history event: CREATED
  await InvestigationEvent.create({
    investigationId: investigation._id,
    projectId,
    actorType: actor?.actorType || 'USER',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType: 'CREATED',
    previousStatus: null,
    newStatus: 'OPEN',
    comment: comment || 'Investigation created',
    metadata: {
      alarmId: linkedAlarm?._id,
      title: investigation.title,
      priority: investigation.priority,
      assignedTo: investigation.assignedTo
    }
  });

  if (assignedTo) {
    await InvestigationEvent.create({
      investigationId: investigation._id,
      projectId,
      actorType: actor?.actorType || 'USER',
      actorId: actor?.userId || actor?.actorId,
      actorEmail: actor?.email,
      actorDisplayName: actor?.displayName,
      eventType: 'ASSIGNED',
      previousStatus: 'OPEN',
      newStatus: 'OPEN',
      comment: `Assigned upon creation to user ${assignedTo}`,
      metadata: { assignedTo }
    });
  }

  emit('investigation.created', {
    investigationId: investigation._id,
    projectId: investigation.projectId,
    status: investigation.status,
    alarmId: investigation.alarmId
  });

  return investigation;
}

/**
 * Assign an investigation to a validated project user.
 */
export async function assignInvestigation({
  investigationId,
  projectId,
  organizationId,
  assignedTo,
  actor,
  comment
}) {
  const query = buildInvestigationQuery({ investigationId, projectId, organizationId });
  const investigation = await Investigation.findOne(query);
  if (!investigation) {
    throw new ApiError(404, 'Investigation not found');
  }

  if (investigation.status === 'COMPLETED') {
    throw new ApiError(409, 'Cannot assign an already completed investigation');
  }

  if (!assignedTo) {
    throw new ApiError(400, 'assignedTo user ID is required');
  }

  await validateProjectUserAccess({ projectId, organizationId, userId: assignedTo });
  const assignee = await User.findById(assignedTo).lean();

  const prevStatus = investigation.status;
  investigation.assignedTo = assignedTo;
  investigation.assignedAt = new Date();
  investigation.updatedBy = actor?.userId || actor?.actorId;
  await investigation.save();

  await InvestigationEvent.create({
    investigationId: investigation._id,
    projectId,
    actorType: actor?.actorType || 'USER',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType: 'ASSIGNED',
    previousStatus: prevStatus,
    newStatus: prevStatus,
    comment: comment || `Assigned to ${assignee?.displayName || assignee?.email || assignedTo}`,
    metadata: {
      assignedTo,
      assigneeName: assignee?.displayName,
      assigneeEmail: assignee?.email
    }
  });

  return investigation;
}

/**
 * Start an investigation: OPEN -> IN_PROGRESS.
 */
export async function startInvestigation({
  investigationId,
  projectId,
  organizationId,
  actor,
  comment
}) {
  const query = buildInvestigationQuery({ investigationId, projectId, organizationId });
  const investigation = await Investigation.findOne(query);
  if (!investigation) {
    throw new ApiError(404, 'Investigation not found');
  }

  if (investigation.status === 'COMPLETED') {
    throw new ApiError(409, 'Cannot start an already completed investigation');
  }

  if (investigation.status === 'IN_PROGRESS') {
    return investigation; // Safe idempotent
  }

  if (investigation.status !== 'OPEN') {
    throw new ApiError(409, `Cannot start investigation with status '${investigation.status}'`);
  }

  const prevStatus = investigation.status;
  const now = new Date();
  investigation.status = 'IN_PROGRESS';
  investigation.startedAt = investigation.startedAt || now;
  investigation.startedBy = actor?.userId || actor?.actorId;
  investigation.updatedBy = actor?.userId || actor?.actorId;
  await investigation.save();

  await InvestigationEvent.create({
    investigationId: investigation._id,
    projectId,
    actorType: actor?.actorType || 'USER',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType: 'STARTED',
    previousStatus: prevStatus,
    newStatus: 'IN_PROGRESS',
    comment: comment || 'Investigation started',
    metadata: { startedAt: investigation.startedAt }
  });

  return investigation;
}

/**
 * Add a finding / note to an active investigation.
 */
export async function addFinding({
  investigationId,
  projectId,
  organizationId,
  text,
  type = 'FINDING',
  evidenceReferences,
  actor
}) {
  const query = buildInvestigationQuery({ investigationId, projectId, organizationId });
  const investigation = await Investigation.findOne(query);
  if (!investigation) {
    throw new ApiError(404, 'Investigation not found');
  }

  if (investigation.status === 'COMPLETED') {
    throw new ApiError(409, 'Cannot add findings to a completed investigation');
  }

  if (!text || !text.trim()) {
    throw new ApiError(400, 'Finding text cannot be empty');
  }

  const note = await InvestigationNote.create({
    investigationId: investigation._id,
    projectId,
    type: type || 'FINDING',
    text: text.trim(),
    evidenceReferences: Array.isArray(evidenceReferences) ? evidenceReferences : [],
    createdBy: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName
  });

  await InvestigationEvent.create({
    investigationId: investigation._id,
    projectId,
    actorType: actor?.actorType || 'USER',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType: 'FINDING_ADDED',
    previousStatus: investigation.status,
    newStatus: investigation.status,
    comment: text.trim().slice(0, 100),
    metadata: {
      findingId: note._id,
      type: note.type,
      text: note.text
    }
  });

  return { finding: note, investigation };
}

/**
 * Complete an investigation: IN_PROGRESS -> COMPLETED.
 * Requires at minimum a conclusion.
 * Linked Alarm status remains UNCHANGED.
 */
export async function completeInvestigation({
  investigationId,
  projectId,
  organizationId,
  conclusion,
  rootCause,
  recommendedAction,
  actor,
  comment
}) {
  const query = buildInvestigationQuery({ investigationId, projectId, organizationId });
  const investigation = await Investigation.findOne(query);
  if (!investigation) {
    throw new ApiError(404, 'Investigation not found');
  }

  if (investigation.status === 'COMPLETED') {
    throw new ApiError(409, 'Investigation is already completed');
  }

  if (investigation.status !== 'IN_PROGRESS') {
    throw new ApiError(409, `Investigation must be IN_PROGRESS before it can be completed (current status: '${investigation.status}')`);
  }

  if (!conclusion || !conclusion.trim()) {
    throw new ApiError(400, 'Conclusion is required to complete an investigation');
  }

  const prevStatus = investigation.status;
  const now = new Date();

  investigation.status = 'COMPLETED';
  investigation.conclusion = conclusion.trim();
  if (rootCause && rootCause.trim()) investigation.rootCause = rootCause.trim();
  if (recommendedAction && recommendedAction.trim()) investigation.recommendedAction = recommendedAction.trim();
  investigation.completedAt = now;
  investigation.completedBy = actor?.userId || actor?.actorId;
  investigation.updatedBy = actor?.userId || actor?.actorId;
  await investigation.save();

  await InvestigationEvent.create({
    investigationId: investigation._id,
    projectId,
    actorType: actor?.actorType || 'USER',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType: 'COMPLETED',
    previousStatus: prevStatus,
    newStatus: 'COMPLETED',
    comment: comment || 'Investigation finalized and completed',
    metadata: {
      conclusion: investigation.conclusion,
      rootCause: investigation.rootCause,
      recommendedAction: investigation.recommendedAction,
      completedAt: investigation.completedAt
    }
  });

  return investigation;
}

/**
 * Get single investigation and its chronological audit events + findings.
 */
export async function getInvestigation({
  investigationId,
  projectId,
  organizationId
}) {
  const query = buildInvestigationQuery({ investigationId, projectId, organizationId });
  const investigation = await Investigation.findOne(query)
    .populate('instrumentId', 'code name')
    .populate('deviceId', 'uid name')
    .populate('gatewayId', 'uid name')
    .populate('assignedTo', 'displayName email')
    .populate('createdBy', 'displayName email')
    .populate('completedBy', 'displayName email')
    .populate('alarmId', 'title category currentSeverity highestSeverity status triggeredAt parameterCode')
    .lean();

  if (!investigation) {
    throw new ApiError(404, 'Investigation not found');
  }

  const events = await InvestigationEvent.find({ investigationId: investigation._id })
    .sort({ createdAt: 1 })
    .populate('actorId', 'displayName email')
    .lean();

  const findings = await InvestigationNote.find({ investigationId: investigation._id })
    .sort({ createdAt: 1 })
    .populate('createdBy', 'displayName email')
    .lean();

  return { investigation, events, findings };
}

/**
 * List project investigations with practical filters.
 */
export async function listInvestigations({
  projectId,
  organizationId,
  status,
  alarmId,
  instrumentId,
  deviceId,
  gatewayId,
  assignedTo,
  priority,
  limit = 50,
  skip = 0
}) {
  const query = { projectId, organizationId };
  if (status) query.status = status;
  if (alarmId) query.alarmId = alarmId;
  if (instrumentId) query.instrumentId = instrumentId;
  if (deviceId) query.deviceId = deviceId;
  if (gatewayId) query.gatewayId = gatewayId;
  if (assignedTo) query.assignedTo = assignedTo;
  if (priority) query.priority = priority;

  const investigations = await Investigation.find(query)
    .sort({ createdAt: -1 })
    .skip(Number(skip))
    .limit(Math.min(Number(limit), 200))
    .populate('assignedTo', 'displayName email')
    .populate('instrumentId', 'code name')
    .populate('alarmId', 'title currentSeverity highestSeverity status')
    .lean();

  return investigations;
}
