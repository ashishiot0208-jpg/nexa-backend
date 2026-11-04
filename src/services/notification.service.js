import mongoose from 'mongoose';
import {
  Notification,
  ProjectMember,
  OrganizationMember,
  User,
  Task,
  Instrument,
  EmployeeProfile
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';

/**
 * Legacy notification queuing for decision engine.
 * Preserved for backward compatibility.
 */
export async function queueAlarmNotifications({ alarm, decision, emit = () => { } }) {
  const members = await ProjectMember.find({
    projectId: alarm.projectId,
    status: 'ACTIVE',
    role: { $in: ['ADMINISTRATOR', 'ENGINEER', 'OPERATOR'] }
  }).lean();
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) }, status: 'ACTIVE' }).lean();
  const payload = {
    alarmId: alarm._id,
    projectId: alarm.projectId,
    severity: alarm.severity,
    healthGrade: alarm.healthGrade,
    state: alarm.state,
    title: alarm.title,
    reasons: alarm.reasonCodes,
    decisionId: decision?._id
  };
  const docs = users.map((u) => ({
    organizationId: alarm.organizationId,
    projectId: alarm.projectId,
    alarmId: alarm._id,
    decisionId: decision?._id,
    channel: 'IN_APP',
    recipient: u.email,
    templateCode: 'ALARM_CHANGED',
    status: 'SENT',
    payload,
    sentAt: new Date()
  }));
  if (docs.length) await Notification.insertMany(docs);
  emit('alarm.changed', payload);
  return docs.length;
}

/**
 * Resolve eligible project administrators for a project.
 *
 * An eligible administrator must:
 * 1. Be an active User.
 * 2. Belong to the project's organization as an active OrganizationMember.
 * 3. Satisfy either:
 *    a) ProjectMember.role === 'ADMINISTRATOR' (and status === 'ACTIVE'), OR
 *    b) OrganizationMember.organizationRole === 'ADMINISTRATOR' (Org Admin override).
 *
 * Excludes:
 * - Non-admin project roles (ENGINEER, OPERATOR, VIEWER)
 * - Users from other organizations
 * - Administrators of other projects (who are not Org Admin)
 * - Inactive users or suspended members
 * - Platform Admin accounts
 */
export async function resolveProjectAdministrators({ organizationId, projectId }) {
  if (!organizationId || !projectId) return [];

  const [orgMembers, projectMembers] = await Promise.all([
    OrganizationMember.find({ organizationId, status: 'ACTIVE' }).lean(),
    ProjectMember.find({ projectId, status: 'ACTIVE' }).lean()
  ]);

  const activeOrgUserIds = new Set(orgMembers.map((om) => om.userId.toString()));

  // Active Org Admins in this organization
  const orgAdminUserIds = new Set(
    orgMembers
      .filter((om) => om.organizationRole === 'ADMINISTRATOR')
      .map((om) => om.userId.toString())
  );

  // Active Project Admins who belong to this active organization
  const projectAdminUserIds = new Set(
    projectMembers
      .filter((pm) => pm.role === 'ADMINISTRATOR' && activeOrgUserIds.has(pm.userId.toString()))
      .map((pm) => pm.userId.toString())
  );

  const eligibleUserIds = Array.from(
    new Set([...orgAdminUserIds, ...projectAdminUserIds])
  ).map((id) => new mongoose.Types.ObjectId(id));

  if (!eligibleUserIds.length) return [];

  // PlatformAdmin accounts are in a separate collection and never present in User collection
  const activeUsers = await User.find({
    _id: { $in: eligibleUserIds },
    status: 'ACTIVE'
  }).select('_id email displayName').lean();

  return activeUsers;
}

/**
 * Dispatch notification to each eligible project administrator.
 * Deduplication is deterministic per (dedupePrefix : relatedObjectId : recipientUserId).
 */
export async function notifyProjectAdministrators({
  organizationId,
  projectId,
  type,
  title,
  message,
  importance = 'NORMAL',
  relatedObjectType,
  relatedObjectId,
  relatedObjectCode,
  relatedObjectSnapshot = {},
  dedupePrefix
}) {
  try {
    const administrators = await resolveProjectAdministrators({ organizationId, projectId });
    if (!administrators || administrators.length === 0) {
      return [];
    }

    const createdNotifications = [];
    for (const admin of administrators) {
      const dedupeKey = dedupePrefix ? `${dedupePrefix}:${relatedObjectId}:${admin._id}` : null;
      try {
        if (dedupeKey) {
          const existing = await Notification.findOne({ dedupeKey }).select('_id').lean();
          if (existing) continue;
        }

        const notification = await Notification.create({
          organizationId,
          projectId,
          recipientUserId: admin._id,
          type,
          title,
          message,
          importance,
          relatedObjectType,
          relatedObjectId,
          relatedObjectCode,
          relatedObjectSnapshot,
          dedupeKey,
          isRead: false,
          readAt: null
        });
        createdNotifications.push(notification);
      } catch (itemErr) {
        if (itemErr.code === 11000 || itemErr.message?.includes('E11000')) {
          continue;
        }
        console.error(`[NotificationService] Error creating notification for admin ${admin._id}:`, itemErr);
      }
    }
    return createdNotifications;
  } catch (err) {
    console.error('[NotificationService] Error in notifyProjectAdministrators:', err);
    return [];
  }
}

/**
 * Event 1: New S4 Alarm created
 */
export async function notifyS4Alarm(alarm, { instrumentCode, parameter } = {}) {
  try {
    if (!alarm) return [];
    const severity = alarm.currentSeverity || alarm.severity;
    if (severity !== 'S4') return [];

    let instCode = instrumentCode;
    let param = parameter || alarm.parameterCode;

    if (!instCode && alarm.instrumentId) {
      try {
        const inst = await Instrument.findById(alarm.instrumentId).select('code').lean();
        instCode = inst?.code;
      } catch (e) {
        // ignore instrument lookup failure
      }
    }

    const alarmCode = alarm.alarmCode || alarm.code || null;
    const title = 'Critical S4 alarm triggered';
    const message = alarm.title
      ? `${alarm.title} reached S4.`
      : `${alarmCode || instCode || 'Alarm'} · ${param ? `${param} reached S4` : 'Critical S4 alarm triggered'}.`;

    return await notifyProjectAdministrators({
      organizationId: alarm.organizationId,
      projectId: alarm.projectId,
      type: 'ADMIN_S4_ALARM',
      title,
      message,
      importance: 'CRITICAL',
      relatedObjectType: 'ALARM',
      relatedObjectId: alarm._id,
      relatedObjectCode: alarmCode,
      relatedObjectSnapshot: {
        alarmId: alarm._id,
        alarmCode,
        instrumentCode: instCode || null,
        parameter: param || null,
        currentSeverity: 'S4',
        title: alarm.title || null
      },
      dedupePrefix: 'ALARM_S4'
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyS4Alarm:', err);
    return [];
  }
}

/**
 * Event 2: Task completed
 */
export async function notifyTaskCompleted(task, actor = {}) {
  try {
    if (!task || task.status !== 'COMPLETED') return [];

    const actorName = actor?.displayName || actor?.name || actor?.email || 'an employee';
    const taskCode = task.taskCode || 'Task';
    const title = 'Task completed';
    const message = `${taskCode} was completed by ${actorName}.`;

    return await notifyProjectAdministrators({
      organizationId: task.organizationId,
      projectId: task.projectId,
      type: 'ADMIN_TASK_COMPLETED',
      title,
      message,
      importance: 'NORMAL',
      relatedObjectType: 'TASK',
      relatedObjectId: task._id,
      relatedObjectCode: task.taskCode,
      relatedObjectSnapshot: {
        taskId: task._id,
        taskCode: task.taskCode || null,
        title: task.title,
        assignedEmployeeDisplayName: task.assignedUserSnapshot?.displayName || null,
        priority: task.priority,
        completedBy: actorName,
        completedAt: task.completedAt || new Date()
      },
      dedupePrefix: 'TASK_COMPLETED'
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyTaskCompleted:', err);
    return [];
  }
}

/**
 * Event 3: Task overdue
 */
export async function notifyTaskOverdue(task) {
  try {
    if (!task) return [];
    const isOverdue = (task.status === 'OPEN' || task.status === 'IN_PROGRESS') &&
      task.dueDate && new Date(task.dueDate) < new Date();
    if (!isOverdue) return [];

    const taskCode = task.taskCode || 'Task';
    const title = 'Task overdue';
    const message = `${taskCode} (${task.title || 'Untitled'}) is overdue.`;

    return await notifyProjectAdministrators({
      organizationId: task.organizationId,
      projectId: task.projectId,
      type: 'ADMIN_TASK_OVERDUE',
      title,
      message,
      importance: 'IMPORTANT',
      relatedObjectType: 'TASK',
      relatedObjectId: task._id,
      relatedObjectCode: task.taskCode,
      relatedObjectSnapshot: {
        taskId: task._id,
        taskCode: task.taskCode || null,
        title: task.title,
        dueDate: task.dueDate,
        priority: task.priority,
        status: task.status
      },
      dedupePrefix: 'TASK_OVERDUE'
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyTaskOverdue:', err);
    return [];
  }
}

/**
 * Scan for overdue tasks and notify administrators (idempotent).
 */
export async function checkAndNotifyOverdueTasks({ organizationId, projectId } = {}) {
  try {
    const now = new Date();
    const filter = {
      status: { $in: ['OPEN', 'IN_PROGRESS'] },
      dueDate: { $lt: now }
    };
    if (organizationId) filter.organizationId = organizationId;
    if (projectId) filter.projectId = projectId;

    const overdueTasks = await Task.find(filter).lean();
    let notifiedCount = 0;
    for (const task of overdueTasks) {
      const created = await notifyTaskOverdue(task);
      notifiedCount += (created?.length || 0);
    }
    return { scanned: overdueTasks.length, notified: notifiedCount };
  } catch (err) {
    console.error('[NotificationService] Error in checkAndNotifyOverdueTasks:', err);
    return { scanned: 0, notified: 0, error: err.message };
  }
}

/**
 * Event 4: Investigation completed
 */
export async function notifyInvestigationCompleted(investigation, actor = {}) {
  try {
    if (!investigation || investigation.status !== 'COMPLETED') return [];

    const actorName = actor?.displayName || actor?.name || actor?.email || 'an employee';
    const invCode = investigation.investigationCode || 'Investigation';
    const title = 'Investigation completed';
    const message = `${invCode} was completed by ${actorName}.`;

    return await notifyProjectAdministrators({
      organizationId: investigation.organizationId,
      projectId: investigation.projectId,
      type: 'ADMIN_INVESTIGATION_COMPLETED',
      title,
      message,
      importance: 'IMPORTANT',
      relatedObjectType: 'INVESTIGATION',
      relatedObjectId: investigation._id,
      relatedObjectCode: investigation.investigationCode,
      relatedObjectSnapshot: {
        investigationId: investigation._id,
        investigationCode: investigation.investigationCode || null,
        title: investigation.title,
        sourceAlarmCode: investigation.alarmSnapshot?.alarmCode || investigation.alarmSnapshot?.title || null,
        assignedEmployee: investigation.assignedUserSnapshot?.displayName || null,
        completedBy: actorName,
        completedAt: investigation.completedAt || new Date()
      },
      dedupePrefix: 'INVESTIGATION_COMPLETED'
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyInvestigationCompleted:', err);
    return [];
  }
}

/**
 * List notifications for current project & recipient with optional filters.
 */
export async function listNotifications({
  organizationId,
  projectId,
  recipientUserId,
  status,
  type,
  limit = 50,
  skip = 0
}) {
  const query = {
    recipientUserId,
    projectId,
    organizationId
  };

  if (status === 'UNREAD') {
    query.isRead = false;
  } else if (status === 'READ') {
    query.isRead = true;
  }

  if (type) {
    query.type = type;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeSkip = Math.max(Number(skip) || 0, 0);

  const notifications = await Notification.find(query)
    .sort({ createdAt: -1 })
    .skip(safeSkip)
    .limit(safeLimit)
    .lean();

  return notifications;
}

/**
 * Count unread notifications for current user in current project.
 */
export async function countUnread({ organizationId, projectId, recipientUserId }) {
  return await Notification.countDocuments({
    organizationId,
    projectId,
    recipientUserId,
    isRead: false
  });
}

/**
 * Mark a single notification as read.
 */
export async function markRead({ organizationId, projectId, recipientUserId, notificationId }) {
  const notification = await Notification.findById(notificationId);
  if (!notification) {
    throw new ApiError(404, 'Notification not found');
  }

  if (notification.organizationId.toString() !== organizationId.toString()) {
    throw new ApiError(403, 'Forbidden: Cross-organization access blocked');
  }
  if (notification.projectId.toString() !== projectId.toString()) {
    throw new ApiError(403, 'Forbidden: Cross-project access blocked');
  }
  if (!notification.recipientUserId || notification.recipientUserId.toString() !== recipientUserId.toString()) {
    throw new ApiError(403, 'Forbidden: Cannot access another user\'s notification');
  }

  notification.isRead = true;
  notification.readAt = new Date();
  await notification.save();
  return notification;
}

/**
 * Mark all notifications for current user in current project as read.
 */
export async function markAllRead({ organizationId, projectId, recipientUserId }) {
  const now = new Date();
  const result = await Notification.updateMany(
    {
      organizationId,
      projectId,
      recipientUserId,
      isRead: false
    },
    {
      $set: { isRead: true, readAt: now }
    }
  );
  return { modifiedCount: result.modifiedCount };
}

/**
 * =============================================================================
 * PHASE 2: EMPLOYEE ASSIGNMENT NOTIFICATIONS (DIRECT RECIPIENT)
 * =============================================================================
 */

/**
 * Validate that an employee user is an eligible direct notification recipient:
 * - Active User in User collection
 * - Active OrganizationMember in the target organization
 * - Active ProjectMember in the target project
 * - Active EmployeeProfile in the target organization
 */
export async function validateDirectEmployeeRecipient({ organizationId, projectId, userId }) {
  if (!organizationId || !projectId || !userId) return null;

  const [user, orgMember, projectMember, employeeProfile] = await Promise.all([
    User.findOne({ _id: userId, status: 'ACTIVE' }).select('_id email displayName').lean(),
    OrganizationMember.findOne({ organizationId, userId, status: 'ACTIVE' }).lean(),
    ProjectMember.findOne({ projectId, userId, status: 'ACTIVE' }).lean(),
    EmployeeProfile.findOne({ organizationId, userId, status: 'ACTIVE' }).lean()
  ]);

  if (!user || !orgMember || !projectMember || !employeeProfile) {
    return null;
  }

  return { user, employeeProfile, projectMember };
}

/**
 * Dispatch a direct notification to a single employee.
 * Validates recipient eligibility, applies transition-based deduplication,
 * and isolates errors so domain workflows are never failed by notification issues.
 */
export async function notifyDirectAssignee({
  organizationId,
  projectId,
  recipientUserId,
  type,
  title,
  message,
  importance = 'NORMAL',
  relatedObjectType,
  relatedObjectId,
  relatedObjectCode,
  relatedObjectSnapshot = {},
  dedupeKey
}) {
  try {
    if (!recipientUserId) return null;

    const recipient = await validateDirectEmployeeRecipient({
      organizationId,
      projectId,
      userId: recipientUserId
    });

    if (!recipient) {
      console.warn(`[NotificationService] Recipient ${recipientUserId} is not an eligible active employee in project ${projectId}`);
      return null;
    }

    if (dedupeKey) {
      const existing = await Notification.findOne({ dedupeKey }).select('_id').lean();
      if (existing) {
        return existing;
      }
    }

    const notification = await Notification.create({
      organizationId,
      projectId,
      recipientUserId,
      type,
      title,
      message,
      importance,
      relatedObjectType,
      relatedObjectId,
      relatedObjectCode,
      relatedObjectSnapshot,
      dedupeKey,
      isRead: false,
      readAt: null
    });

    return notification;
  } catch (err) {
    if (err.code === 11000 || err.message?.includes('E11000')) {
      // Duplicate key collision gracefully handled
      return null;
    }
    console.error(`[NotificationService] Error creating direct employee notification for ${recipientUserId}:`, err);
    return null;
  }
}

/**
 * Event: Task assigned to Employee
 */
export async function notifyTaskAssigned({ task, eventId, actor = {} }) {
  try {
    if (!task || !task.assignedUserId) return null;

    const recipientUserId = task.assignedUserId;
    const taskCode = task.taskCode || 'Task';
    const actorName = actor?.displayName || actor?.name || actor?.email || null;
    const dedupeKey = eventId
      ? `TASK_ASSIGNED:${task._id}:${eventId}:${recipientUserId}`
      : `TASK_ASSIGNED:${task._id}:${Date.now()}:${recipientUserId}`;

    return await notifyDirectAssignee({
      organizationId: task.organizationId,
      projectId: task.projectId,
      recipientUserId,
      type: 'EMPLOYEE_TASK_ASSIGNED',
      title: 'Task assigned to you',
      message: `${taskCode} has been assigned to you.`,
      importance: 'NORMAL',
      relatedObjectType: 'TASK',
      relatedObjectId: task._id,
      relatedObjectCode: task.taskCode || null,
      relatedObjectSnapshot: {
        taskId: task._id,
        taskCode: task.taskCode || null,
        title: task.title,
        priority: task.priority,
        assignedTeam: task.assignedTeamSnapshot?.teamName || null,
        assignedEmployee: task.assignedUserSnapshot?.displayName || null,
        dueDate: task.dueDate || null,
        assignedBy: actorName,
        assignedAt: task.assignedAt || new Date()
      },
      dedupeKey
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyTaskAssigned:', err);
    return null;
  }
}

/**
 * Event: Task reassigned to Employee
 */
export async function notifyTaskReassigned({ task, eventId, actor = {} }) {
  try {
    if (!task || !task.assignedUserId) return null;

    const recipientUserId = task.assignedUserId;
    const taskCode = task.taskCode || 'Task';
    const actorName = actor?.displayName || actor?.name || actor?.email || null;
    const dedupeKey = eventId
      ? `TASK_REASSIGNED:${task._id}:${eventId}:${recipientUserId}`
      : `TASK_REASSIGNED:${task._id}:${Date.now()}:${recipientUserId}`;

    return await notifyDirectAssignee({
      organizationId: task.organizationId,
      projectId: task.projectId,
      recipientUserId,
      type: 'EMPLOYEE_TASK_REASSIGNED',
      title: 'Task reassigned to you',
      message: `${taskCode} has been reassigned to you.`,
      importance: 'NORMAL',
      relatedObjectType: 'TASK',
      relatedObjectId: task._id,
      relatedObjectCode: task.taskCode || null,
      relatedObjectSnapshot: {
        taskId: task._id,
        taskCode: task.taskCode || null,
        title: task.title,
        priority: task.priority,
        assignedTeam: task.assignedTeamSnapshot?.teamName || null,
        assignedEmployee: task.assignedUserSnapshot?.displayName || null,
        dueDate: task.dueDate || null,
        assignedBy: actorName,
        assignedAt: task.assignedAt || new Date()
      },
      dedupeKey
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyTaskReassigned:', err);
    return null;
  }
}

/**
 * Event: Investigation assigned to Employee
 */
export async function notifyInvestigationAssigned({ investigation, eventId, actor = {} }) {
  try {
    if (!investigation || !investigation.assignedTo) return null;

    const recipientUserId = investigation.assignedTo;
    const invCode = investigation.investigationCode || 'Investigation';
    const actorName = actor?.displayName || actor?.name || actor?.email || null;
    const dedupeKey = eventId
      ? `INVESTIGATION_ASSIGNED:${investigation._id}:${eventId}:${recipientUserId}`
      : `INVESTIGATION_ASSIGNED:${investigation._id}:${Date.now()}:${recipientUserId}`;

    return await notifyDirectAssignee({
      organizationId: investigation.organizationId,
      projectId: investigation.projectId,
      recipientUserId,
      type: 'EMPLOYEE_INVESTIGATION_ASSIGNED',
      title: 'Investigation assigned to you',
      message: `${invCode} has been assigned to you.`,
      importance: 'IMPORTANT',
      relatedObjectType: 'INVESTIGATION',
      relatedObjectId: investigation._id,
      relatedObjectCode: investigation.investigationCode || null,
      relatedObjectSnapshot: {
        investigationId: investigation._id,
        investigationCode: investigation.investigationCode || null,
        title: investigation.title,
        sourceAlarmCode: investigation.alarmSnapshot?.alarmCode || investigation.alarmSnapshot?.title || null,
        priority: investigation.priority,
        assignedTeam: investigation.assignedTeamSnapshot?.teamName || null,
        assignedEmployee: investigation.assignedUserSnapshot?.displayName || null,
        assignedBy: actorName,
        assignedAt: investigation.assignedAt || new Date()
      },
      dedupeKey
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyInvestigationAssigned:', err);
    return null;
  }
}

/**
 * Event: Investigation reassigned to Employee
 */
export async function notifyInvestigationReassigned({ investigation, eventId, actor = {} }) {
  try {
    if (!investigation || !investigation.assignedTo) return null;

    const recipientUserId = investigation.assignedTo;
    const invCode = investigation.investigationCode || 'Investigation';
    const actorName = actor?.displayName || actor?.name || actor?.email || null;
    const dedupeKey = eventId
      ? `INVESTIGATION_REASSIGNED:${investigation._id}:${eventId}:${recipientUserId}`
      : `INVESTIGATION_REASSIGNED:${investigation._id}:${Date.now()}:${recipientUserId}`;

    return await notifyDirectAssignee({
      organizationId: investigation.organizationId,
      projectId: investigation.projectId,
      recipientUserId,
      type: 'EMPLOYEE_INVESTIGATION_REASSIGNED',
      title: 'Investigation reassigned to you',
      message: `${invCode} has been assigned to you.`,
      importance: 'IMPORTANT',
      relatedObjectType: 'INVESTIGATION',
      relatedObjectId: investigation._id,
      relatedObjectCode: investigation.investigationCode || null,
      relatedObjectSnapshot: {
        investigationId: investigation._id,
        investigationCode: investigation.investigationCode || null,
        title: investigation.title,
        sourceAlarmCode: investigation.alarmSnapshot?.alarmCode || investigation.alarmSnapshot?.title || null,
        priority: investigation.priority,
        assignedTeam: investigation.assignedTeamSnapshot?.teamName || null,
        assignedEmployee: investigation.assignedUserSnapshot?.displayName || null,
        assignedBy: actorName,
        assignedAt: investigation.assignedAt || new Date()
      },
      dedupeKey
    });
  } catch (err) {
    console.error('[NotificationService] Error in notifyInvestigationReassigned:', err);
    return null;
  }
}
