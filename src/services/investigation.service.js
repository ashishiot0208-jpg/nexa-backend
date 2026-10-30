import mongoose from 'mongoose';
import {
  Investigation,
  InvestigationEvent,
  InvestigationNote,
  Alarm,
  ProjectMember,
  OrganizationMember,
  User,
  Team,
  TeamMember,
  ProjectTeamAccess,
  EmployeeProfile
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from './audit.service.js';

/**
 * Validate that a Team is eligible for assignment on a project.
 * - Team.organizationId must match project organization (no foreign-org)
 * - Team.status === 'ACTIVE' (no inactive teams)
 * - Team must have ACTIVE ProjectTeamAccess for the project
 * - Team must have investigations.view permission if permissions are defined
 */
export async function validateTeamAssignment({ organizationId, projectId, teamId }) {
  if (!teamId) return null;
  if (!mongoose.Types.ObjectId.isValid(teamId)) {
    throw new ApiError(400, 'Invalid team ID format');
  }

  const team = await Team.findById(teamId).lean();
  if (!team) {
    throw new ApiError(404, 'Team not found');
  }

  if (team.organizationId.toString() !== organizationId.toString()) {
    throw new ApiError(403, 'Team does not belong to the project organization');
  }

  if (team.status !== 'ACTIVE') {
    throw new ApiError(400, 'Cannot assign an inactive team to an investigation');
  }

  const teamAccess = await ProjectTeamAccess.findOne({
    organizationId,
    projectId,
    teamId: team._id,
    status: 'ACTIVE'
  }).lean();

  if (!teamAccess) {
    throw new ApiError(400, 'Selected team does not have active access to this project');
  }

  if (Array.isArray(teamAccess.permissions) && teamAccess.permissions.length > 0) {
    if (!teamAccess.permissions.includes('investigations.view')) {
      throw new ApiError(400, 'Selected team does not have investigation permissions for this project');
    }
  }

  return { team, teamAccess };
}

/**
 * Validate that an individual assignee is eligible.
 * When assignedTeamId is provided:
 * - Active OrganizationMember
 * - Active ProjectMember
 * - Active TeamMember of the selected team
 * - Team.status === 'ACTIVE'
 */
export async function validateAssigneeForTeam({ organizationId, projectId, teamId, userId }) {
  if (!userId) return null;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new ApiError(400, 'Invalid user ID format');
  }

  const [user, orgMember, projectMember, employeeProfile] = await Promise.all([
    User.findById(userId).lean(),
    OrganizationMember.findOne({ organizationId, userId, status: 'ACTIVE' }).lean(),
    ProjectMember.findOne({ projectId, userId, status: 'ACTIVE' }).lean(),
    EmployeeProfile.findOne({ organizationId, userId, status: 'ACTIVE' }).lean()
  ]);

  if (!user || user.status === 'DEACTIVATED' || user.status === 'SUSPENDED') {
    throw new ApiError(400, 'Assigned user is not an active user');
  }

  if (!orgMember && user.status !== 'ACTIVE') {
    throw new ApiError(400, 'Assigned user is not an active organization member');
  }

  if (!projectMember && orgMember?.organizationRole !== 'ADMINISTRATOR') {
    throw new ApiError(400, 'Assigned user is not an active member of this project');
  }

  let teamMembership = null;
  if (teamId) {
    teamMembership = await TeamMember.findOne({
      organizationId,
      teamId,
      userId,
      status: 'ACTIVE'
    }).lean();

    if (!teamMembership) {
      throw new ApiError(400, 'Assigned user is not an active member of the selected team');
    }
  }

  return {
    user,
    employeeProfile,
    projectMember,
    teamMember: teamMembership
  };
}

/**
 * Helper to construct assignment snapshots.
 */
export function buildTeamSnapshot(team) {
  if (!team) return null;
  return {
    teamId: team._id,
    teamCode: team.teamCode,
    teamName: team.name
  };
}

export function buildUserSnapshot(user, employeeProfile) {
  if (!user) return null;
  return {
    userId: user._id,
    displayName: employeeProfile?.displayName || user.displayName,
    employeeCode: employeeProfile?.employeeCode || null,
    designation: employeeProfile?.designation || null
  };
}

/**
 * Validate that an assignee has access to the target project (legacy helper).
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
  assignedTeamId,
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

  let assignedTeamSnapshot = null;
  let assignedUserSnapshot = null;
  let validatedTeam = null;
  let validatedUser = null;

  if (assignedTeamId) {
    const { team } = await validateTeamAssignment({ organizationId, projectId, teamId: assignedTeamId });
    validatedTeam = team;
    assignedTeamSnapshot = buildTeamSnapshot(team);
  }

  if (assignedTo) {
    const { user, employeeProfile } = await validateAssigneeForTeam({
      organizationId,
      projectId,
      teamId: assignedTeamId,
      userId: assignedTo
    });
    validatedUser = user;
    assignedUserSnapshot = buildUserSnapshot(user, employeeProfile);
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
    assignedTeamId: validatedTeam ? validatedTeam._id : undefined,
    assignedTeamSnapshot: assignedTeamSnapshot || undefined,
    assignedTo: validatedUser ? validatedUser._id : undefined,
    assignedUserSnapshot: assignedUserSnapshot || undefined,
    assignedAt: (validatedTeam || validatedUser) ? new Date() : undefined,
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
      assignedTeamId: investigation.assignedTeamId,
      assignedTo: investigation.assignedTo
    }
  });

  if (validatedTeam || validatedUser) {
    let assignComment = 'Assigned upon creation';
    if (validatedTeam && validatedUser) {
      assignComment += ` to ${validatedTeam.name} · ${assignedUserSnapshot?.displayName || validatedUser.displayName}`;
    } else if (validatedTeam) {
      assignComment += ` to team ${validatedTeam.name}`;
    } else if (validatedUser) {
      assignComment += ` to user ${assignedUserSnapshot?.displayName || validatedUser.displayName}`;
    }

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
      comment: assignComment,
      metadata: {
        newTeam: assignedTeamSnapshot,
        newAssignee: assignedUserSnapshot,
        assignedTeamId: investigation.assignedTeamId,
        assignedTo: investigation.assignedTo
      }
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
 * Assign or reassign an investigation to a team and/or individual project member.
 * Phase A1E: Supports Team-only, Team + Individual, and legacy Individual-only.
 * Enforces that if a team is assigned, individual assignee must be an active member of that team.
 */
export async function assignInvestigation({
  investigationId,
  projectId,
  organizationId,
  assignedTeamId,
  assignedTo,
  assignedToUserId,
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

  // Normalize inputs: assignedToUserId is alias for assignedTo
  const targetUserId = assignedTo !== undefined ? assignedTo : assignedToUserId;
  const targetTeamId = assignedTeamId;

  // Track previous state for event metadata
  const prevTeamId = investigation.assignedTeamId;
  const prevTeamSnapshot = investigation.assignedTeamSnapshot;
  const prevUserId = investigation.assignedTo;
  const prevUserSnapshot = investigation.assignedUserSnapshot;
  const prevStatus = investigation.status;

  // Case 1: Unassign completely (both team and user are explicitly null or empty string)
  const isTeamExplicitlyCleared = targetTeamId === null || targetTeamId === '';
  const isUserExplicitlyCleared = targetUserId === null || targetUserId === '';

  if (isTeamExplicitlyCleared && (isUserExplicitlyCleared || targetUserId === undefined)) {
    investigation.assignedTeamId = null;
    investigation.assignedTeamSnapshot = null;
    investigation.assignedTo = null;
    investigation.assignedUserSnapshot = null;
    investigation.assignedAt = null;
    investigation.updatedBy = actor?.userId || actor?.actorId;
    await investigation.save();

    await InvestigationEvent.create({
      investigationId: investigation._id,
      projectId,
      actorType: actor?.actorType || 'USER',
      actorId: actor?.userId || actor?.actorId,
      actorEmail: actor?.email,
      actorDisplayName: actor?.displayName,
      eventType: 'UNASSIGNED',
      previousStatus: prevStatus,
      newStatus: prevStatus,
      comment: comment || 'Unassigned investigation',
      metadata: {
        previousTeam: prevTeamSnapshot || (prevTeamId ? { teamId: prevTeamId } : null),
        newTeam: null,
        previousAssignee: prevUserSnapshot || (prevUserId ? { userId: prevUserId } : null),
        newAssignee: null,
        changedBy: actor?.displayName || actor?.email || actor?.userId,
        changedAt: new Date()
      }
    });

    return investigation;
  }

  let validatedTeam = null;
  let teamSnapshot = null;
  let validatedUser = null;
  let userSnapshot = null;

  // Determine effective team
  let effectiveTeamId = targetTeamId;
  if (effectiveTeamId === undefined) {
    // If team is not specified in the payload, retain current assigned team if present
    effectiveTeamId = investigation.assignedTeamId;
  }

  if (effectiveTeamId && !isTeamExplicitlyCleared) {
    const { team } = await validateTeamAssignment({ organizationId, projectId, teamId: effectiveTeamId });
    validatedTeam = team;
    teamSnapshot = buildTeamSnapshot(team);
  }

  // Determine individual assignee
  if (isUserExplicitlyCleared) {
    // Explicitly unassigning individual member while keeping team
    validatedUser = null;
    userSnapshot = null;
  } else if (targetUserId) {
    // Validating new or specified individual
    const { user, employeeProfile } = await validateAssigneeForTeam({
      organizationId,
      projectId,
      teamId: validatedTeam ? validatedTeam._id : null,
      userId: targetUserId
    });
    validatedUser = user;
    userSnapshot = buildUserSnapshot(user, employeeProfile);
  } else if (targetUserId === undefined) {
    // User was not supplied in payload.
    // If team changed, check if existing user belongs to new team!
    if (validatedTeam && prevTeamId && validatedTeam._id.toString() !== prevTeamId.toString()) {
      if (prevUserId) {
        // Changing team: If current assigned person is NOT a member of new Team, reject!
        const { user, employeeProfile } = await validateAssigneeForTeam({
          organizationId,
          projectId,
          teamId: validatedTeam._id,
          userId: prevUserId
        });
        validatedUser = user;
        userSnapshot = buildUserSnapshot(user, employeeProfile);
      }
    } else if (investigation.assignedTo) {
      // Keep existing assigned user
      const existingUser = await User.findById(investigation.assignedTo).lean();
      if (existingUser) {
        const existingProfile = await EmployeeProfile.findOne({
          organizationId,
          userId: existingUser._id,
          status: 'ACTIVE'
        }).lean();
        validatedUser = existingUser;
        userSnapshot = investigation.assignedUserSnapshot || buildUserSnapshot(existingUser, existingProfile);
      }
    }
  }

  // Persist assignment changes
  investigation.assignedTeamId = validatedTeam ? validatedTeam._id : null;
  investigation.assignedTeamSnapshot = teamSnapshot || undefined;
  investigation.assignedTo = validatedUser ? validatedUser._id : null;
  investigation.assignedUserSnapshot = userSnapshot || undefined;
  investigation.assignedAt = (validatedTeam || validatedUser) ? new Date() : null;
  investigation.updatedBy = actor?.userId || actor?.actorId;
  await investigation.save();

  // Audit event
  const isReassigned = Boolean(prevTeamId || prevUserId);
  const eventType = isReassigned ? 'REASSIGNED' : 'ASSIGNED';

  let defaultComment = '';
  if (validatedTeam && validatedUser) {
    defaultComment = `Assigned to ${validatedTeam.name} · ${userSnapshot?.displayName || validatedUser.displayName}`;
  } else if (validatedTeam) {
    defaultComment = `Assigned to team ${validatedTeam.name}`;
  } else if (validatedUser) {
    defaultComment = `Assigned to user ${userSnapshot?.displayName || validatedUser.displayName}`;
  } else {
    defaultComment = 'Assignment updated';
  }

  await InvestigationEvent.create({
    investigationId: investigation._id,
    projectId,
    actorType: actor?.actorType || 'USER',
    actorId: actor?.userId || actor?.actorId,
    actorEmail: actor?.email,
    actorDisplayName: actor?.displayName,
    eventType,
    previousStatus: prevStatus,
    newStatus: prevStatus,
    comment: comment || defaultComment,
    metadata: {
      previousTeam: prevTeamSnapshot || (prevTeamId ? { teamId: prevTeamId } : null),
      newTeam: teamSnapshot || null,
      previousAssignee: prevUserSnapshot || (prevUserId ? { userId: prevUserId } : null),
      newAssignee: userSnapshot || null,
      changedBy: actor?.displayName || actor?.email || actor?.userId,
      changedAt: new Date()
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
    .populate('assignedTeamId', 'teamCode name status')
    .populate('assignedTo', 'displayName email status')
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
  assignedTeamId,
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
  if (assignedTeamId) query.assignedTeamId = assignedTeamId;
  if (priority) query.priority = priority;

  const investigations = await Investigation.find(query)
    .sort({ createdAt: -1 })
    .skip(Number(skip))
    .limit(Math.min(Number(limit), 200))
    .populate('assignedTeamId', 'teamCode name status')
    .populate('assignedTo', 'displayName email status')
    .populate('instrumentId', 'code name')
    .populate('alarmId', 'title currentSeverity highestSeverity status')
    .lean();

  return investigations;
}

/**
 * Retrieve candidate assignment options (teams and members) for a project.
 * Phase A1E: Scoped strictly to project and organization.
 */
export async function getInvestigationAssignmentOptions({ projectId, organizationId, teamId }) {
  if (!projectId || !organizationId) {
    throw new ApiError(400, 'projectId and organizationId are required');
  }

  // 1. Find all ACTIVE ProjectTeamAccess for this project and organization
  const activeAccessList = await ProjectTeamAccess.find({
    organizationId,
    projectId,
    status: 'ACTIVE'
  }).lean();

  const accessTeamIds = activeAccessList.map(a => a.teamId);

  // 2. Find matching ACTIVE Teams in organization
  const activeTeams = await Team.find({
    _id: { $in: accessTeamIds },
    organizationId,
    status: 'ACTIVE'
  }).lean();

  // 3. For each eligible team, get lead displayName and active member count
  const eligibleTeams = await Promise.all(activeTeams.map(async (t) => {
    let leadName = null;
    if (t.teamLeadUserId) {
      const leadProfile = await EmployeeProfile.findOne({
        organizationId,
        userId: t.teamLeadUserId,
        status: 'ACTIVE'
      }).select('displayName').lean();
      if (leadProfile) {
        leadName = leadProfile.displayName;
      } else {
        const leadUser = await User.findById(t.teamLeadUserId).select('displayName').lean();
        leadName = leadUser?.displayName || null;
      }
    }

    const activeMembersCount = await TeamMember.countDocuments({
      organizationId,
      teamId: t._id,
      status: 'ACTIVE'
    });

    return {
      teamId: t._id,
      teamCode: t.teamCode,
      name: t.name,
      lead: leadName,
      activeMemberCount: activeMembersCount
    };
  }));

  // If teamId query parameter was provided, return eligible members for that team
  let eligibleMembers = [];
  if (teamId) {
    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      throw new ApiError(400, 'Invalid teamId parameter');
    }

    const isEligible = activeTeams.some(t => t._id.toString() === teamId.toString());
    if (!isEligible) {
      throw new ApiError(400, 'Team is not eligible or active for this project');
    }

    const teamMembers = await TeamMember.find({
      organizationId,
      teamId,
      status: 'ACTIVE'
    }).lean();

    const userIds = teamMembers.map(tm => tm.userId);

    const [projectMembers, orgAdmins, profiles, users] = await Promise.all([
      ProjectMember.find({ projectId, userId: { $in: userIds }, status: 'ACTIVE' }).lean(),
      OrganizationMember.find({ organizationId, userId: { $in: userIds }, organizationRole: 'ADMINISTRATOR', status: 'ACTIVE' }).lean(),
      EmployeeProfile.find({ organizationId, userId: { $in: userIds }, status: 'ACTIVE' }).lean(),
      User.find({ _id: { $in: userIds }, status: 'ACTIVE' }).lean()
    ]);

    const projectUserIds = new Set([
      ...projectMembers.map(pm => pm.userId.toString()),
      ...orgAdmins.map(oa => oa.userId.toString())
    ]);

    const profileMap = new Map(profiles.map(p => [p.userId.toString(), p]));
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    for (const tm of teamMembers) {
      const uIdStr = tm.userId.toString();
      if (projectUserIds.has(uIdStr)) {
        const prof = profileMap.get(uIdStr);
        const usr = userMap.get(uIdStr);
        if (usr) {
          eligibleMembers.push({
            userId: tm.userId,
            employeeId: prof?._id || null,
            employeeCode: prof?.employeeCode || null,
            displayName: prof?.displayName || usr.displayName,
            designation: prof?.designation || null,
            membershipRole: tm.membershipRole || 'MEMBER',
            isLead: tm.membershipRole === 'LEAD'
          });
        }
      }
    }
  }

  return {
    eligibleTeams,
    teamId: teamId || null,
    eligibleMembers
  };
}
