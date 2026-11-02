import mongoose from 'mongoose';
import {
  Task,
  TaskUpdate,
  TaskEvent,
  User,
  EmployeeProfile,
  OrganizationMember,
  ProjectMember,
  Team,
  TeamMember,
  ProjectTeamAccess,
  Instrument,
  Device,
  Alarm,
  Investigation,
  Project,
  Site
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';

/**
 * Record an audit event for a task
 */
async function recordTaskEvent({
  taskId,
  organizationId,
  projectId,
  eventType,
  actor,
  previousValue = null,
  newValue = null,
  comment = null,
  metadata = {}
}) {
  try {
    return await TaskEvent.create({
      taskId,
      organizationId,
      projectId,
      eventType,
      actorId: actor?.userId || null,
      actorEmail: actor?.email || null,
      actorDisplayName: actor?.displayName || actor?.name || actor?.email || null,
      previousValue,
      newValue,
      comment,
      metadata
    });
  } catch (err) {
    console.error('[TaskService] Failed to record task event:', err);
    return null;
  }
}

/**
 * Build snapshot for assigned user
 */
async function buildUserSnapshot(userId, organizationId, projectId) {
  if (!userId) return null;
  const [user, profile, projMember] = await Promise.all([
    User.findById(userId).select('displayName email status').lean(),
    EmployeeProfile.findOne({ organizationId, userId, status: 'ACTIVE' }).select('displayName employeeCode designation').lean(),
    ProjectMember.findOne({ projectId, userId, status: 'ACTIVE' }).select('role status').lean()
  ]);

  if (!user || user.status !== 'ACTIVE') {
    throw new ApiError(400, 'Assigned user does not exist or is not active');
  }

  return {
    userId: user._id,
    displayName: profile?.displayName || user.displayName || user.email,
    email: user.email,
    employeeCode: profile?.employeeCode || null,
    role: projMember?.role || null
  };
}

/**
 * Build snapshot for assigned team
 */
async function buildTeamSnapshot(teamId, organizationId) {
  if (!teamId) return null;
  const team = await Team.findOne({ _id: teamId, organizationId, status: 'ACTIVE' }).select('teamCode name').lean();
  if (!team) {
    throw new ApiError(400, 'Assigned team does not exist or is not active in this organization');
  }
  return {
    teamId: team._id,
    teamCode: team.teamCode,
    teamName: team.name
  };
}

/**
 * Build snapshot for related object
 */
async function buildRelatedObjectSnapshot(type, id, organizationId, projectId) {
  if (!type || type === 'NONE' || !id) return null;

  if (type === 'INSTRUMENT') {
    const inst = await Instrument.findOne({ _id: id, projectId }).select('code name catalogCode status').lean();
    if (inst) {
      return { id: inst._id, code: inst.code, name: inst.name, catalogCode: inst.catalogCode, status: inst.status, type: 'INSTRUMENT' };
    }
  } else if (type === 'DEVICE') {
    const dev = await Device.findOne({ _id: id, projectId }).select('uid name status').lean();
    if (dev) {
      return { id: dev._id, code: dev.uid, name: dev.name, status: dev.status, type: 'DEVICE' };
    }
  } else if (type === 'ALARM') {
    const al = await Alarm.findOne({ _id: id, projectId }).select('title currentSeverity highestSeverity status triggeredAt').lean();
    if (al) {
      return { id: al._id, code: al.title, name: al.title, severity: al.currentSeverity || al.highestSeverity, status: al.status, type: 'ALARM' };
    }
  } else if (type === 'INVESTIGATION') {
    const inv = await Investigation.findOne({ _id: id, projectId }).select('investigationCode title status priority').lean();
    if (inv) {
      return { id: inv._id, code: inv.investigationCode, name: inv.title, status: inv.status, priority: inv.priority, type: 'INVESTIGATION' };
    }
  } else if (type === 'SITE') {
    const site = await Site.findOne({ _id: id, projectId }).select('code name type').lean();
    if (site) {
      return { id: site._id, code: site.code || site.name, name: site.name, type: 'SITE' };
    }
    if (id.toString() === projectId.toString()) {
      const proj = await Project.findById(projectId).select('code name').lean();
      if (proj) {
        return { id: proj._id, code: proj.code, name: proj.name, type: 'SITE' };
      }
    }
  }

  return null;
}

/**
 * Create a new Task
 */
export async function createTask({
  organizationId,
  projectId,
  title,
  description,
  priority = 'MEDIUM',
  dueDate = null,
  assignedTeamId = null,
  assignedUserId = null,
  relatedObjectType = 'NONE',
  relatedObjectId = null,
  actor
}) {
  if (!organizationId || !projectId) {
    throw new ApiError(400, 'organizationId and projectId are required');
  }
  if (!title || !title.trim()) {
    throw new ApiError(400, 'Task title is required');
  }

  // Issue 4: Require at least one assignment target (assignedTeamId OR assignedUserId)
  if (!assignedTeamId && !assignedUserId) {
    throw new ApiError(400, 'Select a Team or Employee to assign this task.');
  }

  // Issue 3: If both assignedTeamId and assignedUserId are supplied, employee must be an ACTIVE member of team
  if (assignedTeamId && assignedUserId) {
    const membership = await TeamMember.findOne({
      organizationId,
      teamId: assignedTeamId,
      userId: assignedUserId,
      status: 'ACTIVE'
    });
    if (!membership) {
      throw new ApiError(400, 'Selected employee is not an active member of the assigned team.');
    }
  }

  // Issue 1: If relatedObjectType is not NONE, relatedObjectId is required and must resolve to a valid snapshot
  if (relatedObjectType && relatedObjectType !== 'NONE') {
    if (!relatedObjectId) {
      throw new ApiError(400, `A valid ${relatedObjectType} must be selected when a related object type is specified.`);
    }
  }

  const [assignedTeamSnapshot, assignedUserSnapshot, relatedObjectSnapshot] = await Promise.all([
    buildTeamSnapshot(assignedTeamId, organizationId),
    buildUserSnapshot(assignedUserId, organizationId, projectId),
    buildRelatedObjectSnapshot(relatedObjectType, relatedObjectId, organizationId, projectId)
  ]);

  if (relatedObjectType && relatedObjectType !== 'NONE' && !relatedObjectSnapshot) {
    throw new ApiError(400, `Selected ${relatedObjectType} was not found or is invalid for this project.`);
  }

  const createdBySnapshot = actor?.userId ? {
    userId: actor.userId,
    displayName: actor.displayName || actor.name || actor.email || 'System User',
    email: actor.email || ''
  } : null;

  const task = new Task({
    organizationId,
    projectId,
    title: title.trim(),
    description: description ? description.trim() : '',
    status: 'OPEN',
    priority: priority || 'MEDIUM',
    dueDate: dueDate ? new Date(dueDate) : null,
    assignedTeamId: assignedTeamId || null,
    assignedTeamSnapshot,
    assignedUserId: assignedUserId || null,
    assignedUserSnapshot,
    assignedAt: (assignedTeamId || assignedUserId) ? new Date() : null,
    createdByUserId: actor?.userId || null,
    createdBySnapshot,
    relatedObjectType: relatedObjectType || 'NONE',
    relatedObjectId: relatedObjectId || null,
    relatedObjectSnapshot
  });

  await task.save();

  // Audit event: CREATED
  await recordTaskEvent({
    taskId: task._id,
    organizationId,
    projectId,
    eventType: 'CREATED',
    actor,
    newValue: {
      taskCode: task.taskCode,
      title: task.title,
      priority: task.priority,
      status: task.status,
      assignedTeam: assignedTeamSnapshot?.teamName || null,
      assignedUser: assignedUserSnapshot?.displayName || null
    },
    comment: 'Task created'
  });

  if (assignedTeamId || assignedUserId) {
    await recordTaskEvent({
      taskId: task._id,
      organizationId,
      projectId,
      eventType: 'ASSIGNED',
      actor,
      newValue: {
        team: assignedTeamSnapshot?.teamName || null,
        user: assignedUserSnapshot?.displayName || null
      },
      comment: 'Initial assignment upon task creation'
    });
  }

  return task;
}

/**
 * List Tasks for a project with optional filters and counters
 */
export async function listTasks({
  organizationId,
  projectId,
  status,
  priority,
  assignedTeamId,
  assignedUserId,
  myTasksUserId,
  relatedObjectType,
  dueState,
  search,
  limit = 100,
  skip = 0
}) {
  if (!organizationId || !projectId) {
    throw new ApiError(400, 'organizationId and projectId are required');
  }

  const query = {
    organizationId: new mongoose.Types.ObjectId(organizationId),
    projectId: new mongoose.Types.ObjectId(projectId)
  };

  if (status) {
    query.status = status;
  }

  if (priority) {
    query.priority = priority;
  }

  if (assignedTeamId) {
    query.assignedTeamId = new mongoose.Types.ObjectId(assignedTeamId);
  }

  if (assignedUserId) {
    query.assignedUserId = new mongoose.Types.ObjectId(assignedUserId);
  }

  if (myTasksUserId) {
    // Exact individual assignment only (Team-only tasks are NOT automatically personal tasks)
    query.assignedUserId = new mongoose.Types.ObjectId(myTasksUserId);
  }

  if (relatedObjectType && relatedObjectType !== 'ALL') {
    query.relatedObjectType = relatedObjectType;
  }

  const now = new Date();
  if (dueState === 'OVERDUE') {
    query.status = { $in: ['OPEN', 'IN_PROGRESS'] };
    query.dueDate = { $lt: now };
  }

  if (search && search.trim()) {
    const s = search.trim();
    query.$or = [
      { taskCode: { $regex: s, $options: 'i' } },
      { title: { $regex: s, $options: 'i' } },
      { description: { $regex: s, $options: 'i' } }
    ];
  }

  const [tasks, totalCount, openCount, inProgressCount, completedCount, overdueCount] = await Promise.all([
    Task.find(query)
      .sort({ createdAt: -1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean(),
    Task.countDocuments(query),
    Task.countDocuments({ organizationId, projectId, status: 'OPEN' }),
    Task.countDocuments({ organizationId, projectId, status: 'IN_PROGRESS' }),
    Task.countDocuments({ organizationId, projectId, status: 'COMPLETED' }),
    Task.countDocuments({
      organizationId,
      projectId,
      status: { $in: ['OPEN', 'IN_PROGRESS'] },
      dueDate: { $lt: now }
    })
  ]);

  // Derived overdue flag for each row
  const formattedTasks = tasks.map((t) => {
    const isOverdue = (t.status === 'OPEN' || t.status === 'IN_PROGRESS') && t.dueDate && new Date(t.dueDate) < now;
    return {
      ...t,
      isOverdue: Boolean(isOverdue)
    };
  });

  return {
    tasks: formattedTasks,
    totalCount,
    counters: {
      open: openCount,
      inProgress: inProgressCount,
      completed: completedCount,
      overdue: overdueCount,
      activeTotal: openCount + inProgressCount
    }
  };
}

/**
 * Get Task details by ID including updates and audit events
 */
export async function getTask({ organizationId, projectId, taskId }) {
  if (!organizationId || !projectId || !taskId) {
    throw new ApiError(400, 'organizationId, projectId and taskId are required');
  }

  const task = await Task.findOne({ _id: taskId, organizationId, projectId }).lean();
  if (!task) {
    throw new ApiError(404, 'Task not found');
  }

  const [updates, events] = await Promise.all([
    TaskUpdate.find({ taskId, organizationId, projectId }).sort({ createdAt: 1 }).lean(),
    TaskEvent.find({ taskId, organizationId, projectId }).sort({ createdAt: -1 }).lean()
  ]);

  const now = new Date();
  const isOverdue = (task.status === 'OPEN' || task.status === 'IN_PROGRESS') && task.dueDate && new Date(task.dueDate) < now;

  return {
    ...task,
    isOverdue: Boolean(isOverdue),
    updates,
    events
  };
}

/**
 * Assign / Reassign a Task
 */
export async function assignTask({
  organizationId,
  projectId,
  taskId,
  assignedTeamId = null,
  assignedUserId = null,
  actor
}) {
  const task = await Task.findOne({ _id: taskId, organizationId, projectId });
  if (!task) {
    throw new ApiError(404, 'Task not found');
  }

  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw new ApiError(400, `Cannot reassign a ${task.status.toLowerCase()} task`);
  }

  // If both assignedTeamId and assignedUserId are supplied, employee must be an ACTIVE member of team
  if (assignedTeamId && assignedUserId) {
    const membership = await TeamMember.findOne({
      organizationId,
      teamId: assignedTeamId,
      userId: assignedUserId,
      status: 'ACTIVE'
    });
    if (!membership) {
      throw new ApiError(400, 'Selected employee is not an active member of the assigned team.');
    }
  }

  const previousAssignment = {
    team: task.assignedTeamSnapshot?.teamName || null,
    user: task.assignedUserSnapshot?.displayName || null
  };

  const [assignedTeamSnapshot, assignedUserSnapshot] = await Promise.all([
    buildTeamSnapshot(assignedTeamId, organizationId),
    buildUserSnapshot(assignedUserId, organizationId, projectId)
  ]);

  task.assignedTeamId = assignedTeamId || null;
  task.assignedTeamSnapshot = assignedTeamSnapshot;
  task.assignedUserId = assignedUserId || null;
  task.assignedUserSnapshot = assignedUserSnapshot;
  task.assignedAt = (assignedTeamId || assignedUserId) ? new Date() : null;

  await task.save();

  const newAssignment = {
    team: assignedTeamSnapshot?.teamName || null,
    user: assignedUserSnapshot?.displayName || null
  };

  const isUnassign = !assignedTeamId && !assignedUserId;
  const isReassign = (previousAssignment.team || previousAssignment.user) && !isUnassign;
  const eventType = isUnassign ? 'UNASSIGNED' : isReassign ? 'REASSIGNED' : 'ASSIGNED';

  await recordTaskEvent({
    taskId: task._id,
    organizationId,
    projectId,
    eventType,
    actor,
    previousValue: previousAssignment,
    newValue: newAssignment,
    comment: isUnassign ? 'Task unassigned' : `Task assigned to ${newAssignment.user || newAssignment.team || 'unassigned'}`
  });

  return task;
}

/**
 * Start a Task (OPEN -> IN_PROGRESS)
 */
export async function startTask({ organizationId, projectId, taskId, actor }) {
  const task = await Task.findOne({ _id: taskId, organizationId, projectId });
  if (!task) {
    throw new ApiError(404, 'Task not found');
  }

  if (task.status !== 'OPEN') {
    throw new ApiError(400, `Cannot start task with status ${task.status}. Task must be OPEN to start.`);
  }

  task.status = 'IN_PROGRESS';
  task.startedAt = new Date();
  task.startedByUserId = actor?.userId || null;

  await task.save();

  await recordTaskEvent({
    taskId: task._id,
    organizationId,
    projectId,
    eventType: 'STARTED',
    actor,
    previousValue: { status: 'OPEN' },
    newValue: { status: 'IN_PROGRESS', startedAt: task.startedAt },
    comment: 'Task started and transitioned to IN_PROGRESS'
  });

  return task;
}

/**
 * Update Task fields (title, description, priority, dueDate)
 */
export async function updateTask({
  organizationId,
  projectId,
  taskId,
  data = {},
  actor
}) {
  const task = await Task.findOne({ _id: taskId, organizationId, projectId });
  if (!task) {
    throw new ApiError(404, 'Task not found');
  }

  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw new ApiError(400, `Cannot edit fields on a ${task.status.toLowerCase()} task`);
  }

  const { title, description, priority, dueDate } = data;

  if (priority && priority !== task.priority) {
    await recordTaskEvent({
      taskId: task._id,
      organizationId,
      projectId,
      eventType: 'PRIORITY_CHANGED',
      actor,
      previousValue: task.priority,
      newValue: priority,
      comment: `Priority changed from ${task.priority} to ${priority}`
    });
    task.priority = priority;
  }

  if (dueDate !== undefined) {
    const newDueDate = dueDate ? new Date(dueDate) : null;
    const prevDueDate = task.dueDate;
    if (String(prevDueDate) !== String(newDueDate)) {
      await recordTaskEvent({
        taskId: task._id,
        organizationId,
        projectId,
        eventType: 'DUE_DATE_CHANGED',
        actor,
        previousValue: prevDueDate,
        newValue: newDueDate,
        comment: `Due date changed`
      });
      task.dueDate = newDueDate;
    }
  }

  if (title && title.trim()) {
    task.title = title.trim();
  }
  if (description !== undefined) {
    task.description = description.trim();
  }

  await task.save();
  return task;
}

/**
 * Add a lightweight progress update or comment to a task
 */
export async function addTaskUpdate({
  organizationId,
  projectId,
  taskId,
  message,
  updateType = 'COMMENT',
  actor
}) {
  if (!message || !message.trim()) {
    throw new ApiError(400, 'Update message is required');
  }

  const task = await Task.findOne({ _id: taskId, organizationId, projectId });
  if (!task) {
    throw new ApiError(404, 'Task not found');
  }

  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw new ApiError(400, `Cannot add updates to a ${task.status.toLowerCase()} task`);
  }

  const userProfile = actor?.userId ? await EmployeeProfile.findOne({
    organizationId,
    userId: actor.userId,
    status: 'ACTIVE'
  }).select('displayName employeeCode').lean() : null;

  const update = await TaskUpdate.create({
    taskId: task._id,
    organizationId,
    projectId,
    userId: actor.userId,
    userSnapshot: {
      userId: actor.userId,
      displayName: userProfile?.displayName || actor.displayName || actor.name || actor.email || 'User',
      email: actor.email || '',
      employeeCode: userProfile?.employeeCode || null
    },
    message: message.trim(),
    updateType: updateType || 'COMMENT'
  });

  await recordTaskEvent({
    taskId: task._id,
    organizationId,
    projectId,
    eventType: 'UPDATED',
    actor,
    newValue: { message: message.trim(), updateType: update.updateType },
    comment: `Added update: ${message.trim().slice(0, 100)}`
  });

  return update;
}

/**
 * Complete a Task (IN_PROGRESS -> COMPLETED)
 */
export async function completeTask({
  organizationId,
  projectId,
  taskId,
  completionNote,
  actor
}) {
  const task = await Task.findOne({ _id: taskId, organizationId, projectId });
  if (!task) {
    throw new ApiError(404, 'Task not found');
  }

  if (task.status !== 'IN_PROGRESS') {
    throw new ApiError(400, `Cannot complete task with status ${task.status}. Task must be IN_PROGRESS to complete.`);
  }

  task.status = 'COMPLETED';
  task.completedAt = new Date();
  task.completedByUserId = actor?.userId || null;
  task.completionNote = completionNote ? completionNote.trim() : '';

  await task.save();

  await recordTaskEvent({
    taskId: task._id,
    organizationId,
    projectId,
    eventType: 'COMPLETED',
    actor,
    previousValue: { status: 'IN_PROGRESS' },
    newValue: { status: 'COMPLETED', completedAt: task.completedAt, completionNote: task.completionNote },
    comment: task.completionNote ? `Completed: ${task.completionNote}` : 'Task marked as COMPLETED'
  });

  return task;
}

/**
 * Cancel a Task (OPEN or IN_PROGRESS -> CANCELLED)
 */
export async function cancelTask({
  organizationId,
  projectId,
  taskId,
  cancellationReason,
  actor
}) {
  const task = await Task.findOne({ _id: taskId, organizationId, projectId });
  if (!task) {
    throw new ApiError(404, 'Task not found');
  }

  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw new ApiError(400, `Cannot cancel a task that is already ${task.status.toLowerCase()}`);
  }

  const prevStatus = task.status;
  task.status = 'CANCELLED';
  task.cancelledAt = new Date();
  task.cancelledByUserId = actor?.userId || null;
  task.cancellationReason = cancellationReason ? cancellationReason.trim() : '';

  await task.save();

  await recordTaskEvent({
    taskId: task._id,
    organizationId,
    projectId,
    eventType: 'CANCELLED',
    actor,
    previousValue: { status: prevStatus },
    newValue: { status: 'CANCELLED', cancelledAt: task.cancelledAt, cancellationReason: task.cancellationReason },
    comment: task.cancellationReason ? `Cancelled: ${task.cancellationReason}` : 'Task marked as CANCELLED'
  });

  return task;
}

/**
 * Get assignment options and related objects for Task creation and reassignment
 */
export async function getTaskAssignmentOptions({ organizationId, projectId, teamId = null }) {
  if (!organizationId || !projectId) {
    throw new ApiError(400, 'organizationId and projectId are required');
  }

  // 1. Eligible Teams: ACTIVE Teams with active ProjectTeamAccess, or all active organization teams
  const accessList = await ProjectTeamAccess.find({
    organizationId,
    projectId,
    status: 'ACTIVE'
  }).lean();

  let activeTeams = [];
  if (accessList.length > 0) {
    const accessTeamIds = accessList.map((a) => a.teamId);
    activeTeams = await Team.find({
      _id: { $in: accessTeamIds },
      organizationId,
      status: 'ACTIVE'
    }).select('teamCode name teamLeadUserId').lean();
  } else {
    activeTeams = await Team.find({
      organizationId,
      status: 'ACTIVE'
    }).select('teamCode name teamLeadUserId').lean();
  }

  // 2. Eligible Employees: ACTIVE ProjectMembers who are ACTIVE OrganizationMembers with ACTIVE EmployeeProfiles
  const [projectMembers, orgMembers] = await Promise.all([
    ProjectMember.find({ projectId, status: 'ACTIVE' }).lean(),
    OrganizationMember.find({ organizationId, status: 'ACTIVE' }).lean()
  ]);

  const activeOrgMemberUserIds = new Set(orgMembers.map((om) => om.userId.toString()));
  const orgAdmins = orgMembers.filter((om) => om.organizationRole === 'ADMINISTRATOR');
  const orgAdminUserIds = new Set(orgAdmins.map((oa) => oa.userId.toString()));

  const allEligibleUserIds = Array.from(new Set([
    ...projectMembers.map((pm) => pm.userId.toString()),
    ...orgAdmins.map((oa) => oa.userId.toString())
  ])).filter((id) => activeOrgMemberUserIds.has(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const [activeUsers, profiles, teamMemberships] = await Promise.all([
    User.find({ _id: { $in: allEligibleUserIds }, status: 'ACTIVE' }).select('displayName email').lean(),
    EmployeeProfile.find({ organizationId, userId: { $in: allEligibleUserIds }, status: 'ACTIVE' }).select('displayName employeeCode designation userId').lean(),
    TeamMember.find({ organizationId, userId: { $in: allEligibleUserIds }, status: 'ACTIVE' }).lean()
  ]);

  const userMap = new Map(activeUsers.map((u) => [u._id.toString(), u]));
  const projMemberMap = new Map(projectMembers.map((pm) => [pm.userId.toString(), pm]));

  // Group active teams by user
  const userTeamIdsMap = new Map();
  for (const tm of teamMemberships) {
    const uStr = tm.userId.toString();
    if (!userTeamIdsMap.has(uStr)) {
      userTeamIdsMap.set(uStr, []);
    }
    userTeamIdsMap.get(uStr).push(tm.teamId.toString());
  }

  // Iterate over ACTIVE EmployeeProfiles only - excludes unrelated non-employee users
  const eligibleEmployees = [];
  for (const prof of profiles) {
    const uStr = prof.userId.toString();
    const u = userMap.get(uStr);
    if (!u) continue; // User must be active
    const pm = projMemberMap.get(uStr);
    eligibleEmployees.push({
      userId: u._id,
      displayName: prof.displayName || u.displayName || u.email,
      email: u.email,
      employeeCode: prof.employeeCode || null,
      designation: prof.designation || null,
      role: pm?.role || (orgAdminUserIds.has(uStr) ? 'ADMINISTRATOR' : 'VIEWER'),
      teamIds: userTeamIdsMap.get(uStr) || []
    });
  }

  // 3. Related Object candidates
  const [instruments, devices, alarms, investigations, sites, projectDoc] = await Promise.all([
    Instrument.find({ projectId }).select('code name catalogCode status').sort({ code: 1 }).limit(100).lean(),
    Device.find({ projectId }).select('uid name status').sort({ name: 1 }).limit(100).lean(),
    Alarm.find({ projectId, status: { $ne: 'RESOLVED' } }).select('title currentSeverity highestSeverity status triggeredAt').sort({ triggeredAt: -1 }).limit(50).lean(),
    Investigation.find({ projectId, status: { $ne: 'COMPLETED' } }).select('investigationCode title status priority').sort({ createdAt: -1 }).limit(50).lean(),
    Site.find({ projectId }).select('code name').sort({ name: 1 }).limit(50).lean(),
    Project.findById(projectId).select('code name').lean()
  ]);

  const siteList = sites.map((s) => ({ id: s._id, code: s.code || s.name, name: s.name, type: 'SITE' }));
  if (siteList.length === 0 && projectDoc) {
    siteList.push({ id: projectDoc._id, code: projectDoc.code, name: projectDoc.name, type: 'SITE' });
  }

  return {
    eligibleTeams: activeTeams.map((t) => ({
      teamId: t._id,
      teamCode: t.teamCode,
      name: t.name
    })),
    eligibleEmployees,
    relatedObjects: {
      instruments: instruments.map((i) => ({ id: i._id, code: i.code, name: i.name, type: 'INSTRUMENT' })),
      devices: devices.map((d) => ({ id: d._id, code: d.uid, name: d.name, type: 'DEVICE' })),
      alarms: alarms.map((a) => ({ id: a._id, code: a.title, name: a.title, severity: a.currentSeverity || a.highestSeverity, type: 'ALARM' })),
      investigations: investigations.map((inv) => ({ id: inv._id, code: inv.investigationCode, name: inv.title, type: 'INVESTIGATION' })),
      sites: siteList
    }
  };
}
