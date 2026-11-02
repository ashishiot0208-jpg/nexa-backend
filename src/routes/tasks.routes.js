import { Router } from 'express';
import { requireAuth, requireProjectAccess, requireProjectPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  assignTask,
  startTask,
  completeTask,
  cancelTask,
  addTaskUpdate,
  getTaskAssignmentOptions
} from '../services/task.service.js';
import { TaskEvent } from '../models/index.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/v1/projects/:projectId/tasks/assignment-options
 * Assignment options and related objects for tasks
 */
router.get(
  '/projects/:projectId/tasks/assignment-options',
  requireProjectAccess,
  requireProjectPermission('tasks.view'),
  asyncHandler(async (req, res) => {
    const options = await getTaskAssignmentOptions({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      teamId: req.query.teamId
    });
    res.json(options);
  })
);

/**
 * GET /api/v1/projects/:projectId/tasks
 * List tasks for a project with optional filters and counters
 */
router.get(
  '/projects/:projectId/tasks',
  requireProjectAccess,
  requireProjectPermission('tasks.view'),
  asyncHandler(async (req, res) => {
    const {
      status,
      priority,
      assignedTeamId,
      assignedUserId,
      myTasks,
      relatedObjectType,
      dueState,
      search,
      limit,
      skip
    } = req.query;

    const myTasksUserId = myTasks === 'true' ? req.auth.userId : null;

    const result = await listTasks({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      status,
      priority,
      assignedTeamId,
      assignedUserId,
      myTasksUserId,
      relatedObjectType,
      dueState,
      search,
      limit: limit ? Number(limit) : 100,
      skip: skip ? Number(skip) : 0
    });

    res.json(result);
  })
);

/**
 * POST /api/v1/projects/:projectId/tasks
 * Create a new task
 */
router.post(
  '/projects/:projectId/tasks',
  requireProjectAccess,
  requireProjectPermission('tasks.create'),
  asyncHandler(async (req, res) => {
    const {
      title,
      description,
      priority,
      dueDate,
      assignedTeamId,
      assignedUserId,
      relatedObjectType,
      relatedObjectId
    } = req.body;

    const task = await createTask({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      title,
      description,
      priority,
      dueDate,
      assignedTeamId,
      assignedUserId,
      relatedObjectType,
      relatedObjectId,
      actor: {
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      }
    });

    res.status(201).json(task);
  })
);

/**
 * GET /api/v1/projects/:projectId/tasks/:taskId
 * Get a single task by ID with updates and audit events
 */
router.get(
  '/projects/:projectId/tasks/:taskId',
  requireProjectAccess,
  requireProjectPermission('tasks.view'),
  asyncHandler(async (req, res) => {
    const task = await getTask({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      taskId: req.params.taskId
    });
    res.json(task);
  })
);

/**
 * PATCH /api/v1/projects/:projectId/tasks/:taskId
 * Update task metadata (title, description, priority, dueDate)
 */
router.patch(
  '/projects/:projectId/tasks/:taskId',
  requireProjectAccess,
  requireProjectPermission('tasks.update'),
  asyncHandler(async (req, res) => {
    const task = await updateTask({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      data: req.body,
      actor: {
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      }
    });
    res.json(task);
  })
);

/**
 * POST /api/v1/projects/:projectId/tasks/:taskId/assign
 * Assign or reassign a task to team and/or employee
 */
router.post(
  '/projects/:projectId/tasks/:taskId/assign',
  requireProjectAccess,
  requireProjectPermission('tasks.assign'),
  asyncHandler(async (req, res) => {
    const { assignedTeamId, assignedUserId } = req.body;
    const task = await assignTask({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      assignedTeamId,
      assignedUserId,
      actor: {
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      }
    });
    res.json(task);
  })
);

/**
 * POST /api/v1/projects/:projectId/tasks/:taskId/start
 * Transition task from OPEN to IN_PROGRESS
 */
router.post(
  '/projects/:projectId/tasks/:taskId/start',
  requireProjectAccess,
  requireProjectPermission('tasks.start'),
  asyncHandler(async (req, res) => {
    const task = await startTask({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      actor: {
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      }
    });
    res.json(task);
  })
);

/**
 * POST /api/v1/projects/:projectId/tasks/:taskId/complete
 * Transition task from IN_PROGRESS to COMPLETED
 */
router.post(
  '/projects/:projectId/tasks/:taskId/complete',
  requireProjectAccess,
  requireProjectPermission('tasks.complete'),
  asyncHandler(async (req, res) => {
    const { completionNote } = req.body;
    const task = await completeTask({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      completionNote,
      actor: {
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      }
    });
    res.json(task);
  })
);

/**
 * POST /api/v1/projects/:projectId/tasks/:taskId/cancel
 * Cancel an open or in-progress task
 */
router.post(
  '/projects/:projectId/tasks/:taskId/cancel',
  requireProjectAccess,
  requireProjectPermission('tasks.cancel'),
  asyncHandler(async (req, res) => {
    const { cancellationReason } = req.body;
    const task = await cancelTask({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      cancellationReason,
      actor: {
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      }
    });
    res.json(task);
  })
);

/**
 * GET /api/v1/projects/:projectId/tasks/:taskId/events
 * Get audit events for a task
 */
router.get(
  '/projects/:projectId/tasks/:taskId/events',
  requireProjectAccess,
  requireProjectPermission('tasks.view'),
  asyncHandler(async (req, res) => {
    const events = await TaskEvent.find({
      taskId: req.params.taskId,
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId
    }).sort({ createdAt: -1 }).lean();
    res.json(events);
  })
);

/**
 * POST /api/v1/projects/:projectId/tasks/:taskId/updates
 * Add a lightweight update/comment to a task
 */
router.post(
  '/projects/:projectId/tasks/:taskId/updates',
  requireProjectAccess,
  requireProjectPermission('tasks.update'),
  asyncHandler(async (req, res) => {
    const { message, updateType } = req.body;
    const update = await addTaskUpdate({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      message,
      updateType,
      actor: {
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      }
    });
    res.status(201).json(update);
  })
);

export default router;
