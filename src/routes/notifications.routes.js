import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import {
  listNotifications,
  countUnread,
  markRead,
  markAllRead
} from '../services/notification.service.js';
import { Notification, Project, ProjectMember } from '../models/index.js';

const router = Router();
router.use(requireAuth);

/**
 * Project Administrator access & organization isolation middleware.
 * Enforces:
 * 1. Project must exist (404 if not found).
 * 2. Project organization must match authenticated user's organization (403 if mismatch).
 * 3. Authenticated user must be an eligible Administrator for this project:
 *    - Organization Administrator override (organizationRole === 'ADMINISTRATOR'), OR
 *    - Active ProjectMember with role === 'ADMINISTRATOR'.
 */
async function requireProjectAdminAccess(req, _res, next) {
  try {
    const projectId = req.params.projectId;
    if (!projectId) throw new ApiError(400, 'Project id is required');

    const project = await Project.findById(projectId).select('organizationId accessMode').lean();
    if (!project) throw new ApiError(404, 'Project not found');

    const userOrgId = req.auth?.organizationId?.toString();
    const projectOrgId = project.organizationId?.toString();
    if (userOrgId && projectOrgId && userOrgId !== projectOrgId) {
      throw new ApiError(403, 'Forbidden: Cross-organization access blocked');
    }

    if (req.auth?.organizationRole === 'ADMINISTRATOR') {
      req.projectRole = 'ADMINISTRATOR';
      return next();
    }

    const membership = await ProjectMember.findOne({
      projectId,
      userId: req.auth?.userId,
      status: 'ACTIVE'
    }).lean();

    if (!membership || membership.role !== 'ADMINISTRATOR') {
      throw new ApiError(403, 'Administrator access required for this notification inbox');
    }

    req.projectRole = membership.role;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/projects/:projectId/notifications
 * List notifications for current project & authenticated administrator.
 */
router.get(
  '/projects/:projectId/notifications',
  requireProjectAdminAccess,
  asyncHandler(async (req, res) => {
    const { status, type, limit, skip, page, envelope, format } = req.query;

    const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const parsedSkip = Math.max(
      Number(skip) || (page ? (Number(page) - 1) * parsedLimit : 0),
      0
    );

    const [notifications, unreadTotal] = await Promise.all([
      listNotifications({
        organizationId: req.auth.organizationId,
        projectId: req.params.projectId,
        recipientUserId: req.auth.userId,
        status,
        type,
        limit: parsedLimit,
        skip: parsedSkip
      }),
      countUnread({
        organizationId: req.auth.organizationId,
        projectId: req.params.projectId,
        recipientUserId: req.auth.userId
      })
    ]);

    const totalCountQuery = {
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      recipientUserId: req.auth.userId
    };
    if (status === 'UNREAD') totalCountQuery.isRead = false;
    else if (status === 'READ') totalCountQuery.isRead = true;
    if (type) totalCountQuery.type = type;

    const totalCount = await Notification.countDocuments(totalCountQuery);

    res.set('X-Total-Count', String(totalCount));
    res.set('X-Unread-Count', String(unreadTotal));

    if (envelope === 'true' || format === 'object') {
      res.json({
        notifications,
        totalCount,
        unreadCount: unreadTotal
      });
    } else {
      res.json(notifications);
    }
  })
);

/**
 * GET /api/v1/projects/:projectId/notifications/unread-count
 * Unread notification count for current project & authenticated administrator.
 */
router.get(
  '/projects/:projectId/notifications/unread-count',
  requireProjectAdminAccess,
  asyncHandler(async (req, res) => {
    const unread = await countUnread({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      recipientUserId: req.auth.userId
    });
    res.json({ count: unread, unreadCount: unread });
  })
);

/**
 * Handler for marking a single notification as read.
 */
const handleMarkRead = asyncHandler(async (req, res) => {
  const updated = await markRead({
    organizationId: req.auth.organizationId,
    projectId: req.params.projectId,
    recipientUserId: req.auth.userId,
    notificationId: req.params.notificationId
  });
  res.json(updated);
});

/**
 * PATCH /api/v1/projects/:projectId/notifications/:notificationId/read
 * Mark single notification as read.
 */
router.patch(
  '/projects/:projectId/notifications/:notificationId/read',
  requireProjectAdminAccess,
  handleMarkRead
);

/**
 * POST /api/v1/projects/:projectId/notifications/:notificationId/read
 * Support POST alias for mark single read.
 */
router.post(
  '/projects/:projectId/notifications/:notificationId/read',
  requireProjectAdminAccess,
  handleMarkRead
);

/**
 * POST /api/v1/projects/:projectId/notifications/mark-all-read
 * Mark all notifications for current user in current project as read.
 */
router.post(
  '/projects/:projectId/notifications/mark-all-read',
  requireProjectAdminAccess,
  asyncHandler(async (req, res) => {
    const result = await markAllRead({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      recipientUserId: req.auth.userId
    });
    res.json({
      success: true,
      modifiedCount: result.modifiedCount,
      count: result.modifiedCount,
      message: 'All notifications marked as read'
    });
  })
);

export default router;
