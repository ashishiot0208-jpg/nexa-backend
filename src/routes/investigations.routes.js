import { Router } from 'express';
import { requireAuth, requireProjectAccess, requireProjectPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import {
  createInvestigation,
  assignInvestigation,
  startInvestigation,
  addFinding,
  completeInvestigation,
  getInvestigation,
  listInvestigations,
  getInvestigationAssignmentOptions
} from '../services/investigation.service.js';

const router = Router();
router.use(requireAuth);

/**
 * Helper to ensure user is not read-only VIEWER.
 */
function assertMutationAllowed(req) {
  if (req.projectRole === 'VIEWER') {
    throw new ApiError(403, 'Viewer permission is read-only. Cannot modify investigations.');
  }
}

// =========================================================================
// CANONICAL PROJECT-SCOPED INVESTIGATION ENDPOINTS (Phase C7A / A1E)
// =========================================================================

/**
 * GET /api/v1/projects/:projectId/investigations
 * List investigations for a project with optional filters.
 */
router.get(
  '/projects/:projectId/investigations',
  requireProjectAccess,
  requireProjectPermission('investigations.view'),
  asyncHandler(async (req, res) => {
    const {
      status,
      alarmId,
      instrumentId,
      deviceId,
      gatewayId,
      assignedTo,
      assignedTeamId,
      priority,
      limit,
      skip
    } = req.query;

    const investigations = await listInvestigations({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      status,
      alarmId,
      instrumentId,
      deviceId,
      gatewayId,
      assignedTo,
      assignedTeamId,
      priority,
      limit,
      skip
    });

    res.json(investigations);
  })
);

/**
 * GET /api/v1/projects/:projectId/investigations/assignment-options
 * Get eligible teams and members for assignment (Phase A1E).
 */
router.get(
  '/projects/:projectId/investigations/assignment-options',
  requireProjectAccess,
  requireProjectPermission('investigations.view'),
  asyncHandler(async (req, res) => {
    const options = await getInvestigationAssignmentOptions({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      teamId: req.query.teamId
    });

    res.json(options);
  })
);

/**
 * GET /api/v1/projects/:projectId/investigations/:investigationId
 * Retrieve single investigation, its audit events, and chronological findings.
 */
const handleGetInvestigation = asyncHandler(async (req, res) => {
  const investigationId = req.params.investigationId || req.params.id;
  const result = await getInvestigation({
    investigationId,
    projectId: req.params.projectId,
    organizationId: req.auth.organizationId
  });

  res.json(result);
});

router.get(
  '/projects/:projectId/investigations/:investigationId',
  requireProjectAccess,
  requireProjectPermission('investigations.view'),
  handleGetInvestigation
);
router.get(
  '/projects/:projectId/investigations/detail/:id',
  requireProjectAccess,
  requireProjectPermission('investigations.view'),
  handleGetInvestigation
);

/**
 * POST /api/v1/projects/:projectId/investigations
 * Create a new canonical investigation (optional Alarm linkage).
 */
router.post(
  '/projects/:projectId/investigations',
  requireProjectAccess,
  requireProjectPermission('investigations.start'),
  asyncHandler(async (req, res) => {
    assertMutationAllowed(req);

    const {
      title,
      description,
      alarmId,
      instrumentId,
      deviceId,
      gatewayId,
      parameterCode,
      category,
      source,
      priority,
      assignedTeamId,
      assignedTo,
      comment
    } = req.body;

    const investigation = await createInvestigation({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      title,
      description,
      alarmId,
      instrumentId,
      deviceId,
      gatewayId,
      parameterCode,
      category,
      source,
      priority,
      assignedTeamId,
      assignedTo,
      actor: {
        actorType: 'USER',
        userId: req.auth.userId,
        email: req.auth.email,
        displayName: req.auth.displayName
      },
      comment,
      emit: req.app?.locals?.emitEvent || (() => {})
    });

    res.status(201).json(investigation);
  })
);

/**
 * POST & PATCH /api/v1/projects/:projectId/investigations/:id/assign
 * Assign investigation to team and/or project user.
 */
const handleAssign = asyncHandler(async (req, res) => {
  assertMutationAllowed(req);

  const investigationId = req.params.investigationId || req.params.id;
  const { assignedTeamId, assignedTo, assignedToUserId, comment } = req.body;

  const updated = await assignInvestigation({
    investigationId,
    projectId: req.params.projectId,
    organizationId: req.auth.organizationId,
    assignedTeamId,
    assignedTo,
    assignedToUserId,
    actor: {
      actorType: 'USER',
      userId: req.auth.userId,
      email: req.auth.email,
      displayName: req.auth.displayName
    },
    comment
  });

  res.json(updated);
});

router.post(
  '/projects/:projectId/investigations/:id/assign',
  requireProjectAccess,
  requireProjectPermission('investigations.assign'),
  handleAssign
);
router.patch(
  '/projects/:projectId/investigations/:id/assign',
  requireProjectAccess,
  requireProjectPermission('investigations.assign'),
  handleAssign
);
router.post(
  '/projects/:projectId/investigations/:investigationId/assign',
  requireProjectAccess,
  requireProjectPermission('investigations.assign'),
  handleAssign
);
router.patch(
  '/projects/:projectId/investigations/:investigationId/assign',
  requireProjectAccess,
  requireProjectPermission('investigations.assign'),
  handleAssign
);

/**
 * POST & PATCH /api/v1/projects/:projectId/investigations/:id/start
 * Transition investigation OPEN -> IN_PROGRESS.
 */
const handleStart = asyncHandler(async (req, res) => {
  assertMutationAllowed(req);

  const investigationId = req.params.investigationId || req.params.id;
  const { comment } = req.body;

  const updated = await startInvestigation({
    investigationId,
    projectId: req.params.projectId,
    organizationId: req.auth.organizationId,
    actor: {
      actorType: 'USER',
      userId: req.auth.userId,
      email: req.auth.email,
      displayName: req.auth.displayName
    },
    comment
  });

  res.json(updated);
});

router.post(
  '/projects/:projectId/investigations/:id/start',
  requireProjectAccess,
  requireProjectPermission('investigations.start'),
  handleStart
);
router.patch(
  '/projects/:projectId/investigations/:id/start',
  requireProjectAccess,
  requireProjectPermission('investigations.start'),
  handleStart
);
router.post(
  '/projects/:projectId/investigations/:investigationId/start',
  requireProjectAccess,
  requireProjectPermission('investigations.start'),
  handleStart
);
router.patch(
  '/projects/:projectId/investigations/:investigationId/start',
  requireProjectAccess,
  requireProjectPermission('investigations.start'),
  handleStart
);

/**
 * POST /api/v1/projects/:projectId/investigations/:id/findings
 * Add finding/note to investigation.
 */
const handleAddFinding = asyncHandler(async (req, res) => {
  assertMutationAllowed(req);

  const investigationId = req.params.investigationId || req.params.id;
  const { text, type, evidenceReferences } = req.body;

  const result = await addFinding({
    investigationId,
    projectId: req.params.projectId,
    organizationId: req.auth.organizationId,
    text,
    type,
    evidenceReferences,
    actor: {
      actorType: 'USER',
      userId: req.auth.userId,
      email: req.auth.email,
      displayName: req.auth.displayName
    }
  });

  res.status(201).json(result);
});

router.post(
  '/projects/:projectId/investigations/:id/findings',
  requireProjectAccess,
  requireProjectPermission('investigations.addFinding'),
  handleAddFinding
);
router.post(
  '/projects/:projectId/investigations/:investigationId/findings',
  requireProjectAccess,
  requireProjectPermission('investigations.addFinding'),
  handleAddFinding
);

/**
 * POST & PATCH /api/v1/projects/:projectId/investigations/:id/complete
 * Transition investigation IN_PROGRESS -> COMPLETED with required conclusion.
 */
const handleComplete = asyncHandler(async (req, res) => {
  assertMutationAllowed(req);

  const investigationId = req.params.investigationId || req.params.id;
  const { conclusion, rootCause, recommendedAction, comment } = req.body;

  const updated = await completeInvestigation({
    investigationId,
    projectId: req.params.projectId,
    organizationId: req.auth.organizationId,
    conclusion,
    rootCause,
    recommendedAction,
    actor: {
      actorType: 'USER',
      userId: req.auth.userId,
      email: req.auth.email,
      displayName: req.auth.displayName
    },
    comment
  });

  res.json(updated);
});

router.post(
  '/projects/:projectId/investigations/:id/complete',
  requireProjectAccess,
  requireProjectPermission('investigations.complete'),
  handleComplete
);
router.patch(
  '/projects/:projectId/investigations/:id/complete',
  requireProjectAccess,
  requireProjectPermission('investigations.complete'),
  handleComplete
);
router.post(
  '/projects/:projectId/investigations/:investigationId/complete',
  requireProjectAccess,
  requireProjectPermission('investigations.complete'),
  handleComplete
);
router.patch(
  '/projects/:projectId/investigations/:investigationId/complete',
  requireProjectAccess,
  requireProjectPermission('investigations.complete'),
  handleComplete
);

export default router;
