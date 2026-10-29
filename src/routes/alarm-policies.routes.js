import { Router } from 'express';
import { requireAuth, requireProjectAccess, requireProjectPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import {
  listAlarmPolicies,
  getAlarmPolicy,
  createAlarmPolicy,
  updateAlarmPolicy,
  setAlarmPolicyStatus
} from '../services/alarm-policy.service.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/v1/projects/:projectId/alarm-policies
 * List alarm trigger policies for a project.
 */
router.get(
  '/projects/:projectId/alarm-policies',
  requireProjectAccess,
  requireProjectPermission('alarmPolicies.view'),
  asyncHandler(async (req, res) => {
    const { status, category, scope } = req.query;
    const policies = await listAlarmPolicies({
      projectId: req.params.projectId,
      status,
      category,
      scope
    });
    res.json(policies);
  })
);

/**
 * GET /api/v1/projects/:projectId/alarm-policies/:id
 * Retrieve a single alarm trigger policy.
 */
router.get(
  '/projects/:projectId/alarm-policies/:id',
  requireProjectAccess,
  requireProjectPermission('alarmPolicies.view'),
  asyncHandler(async (req, res) => {
    const policy = await getAlarmPolicy({
      policyId: req.params.id,
      projectId: req.params.projectId
    });
    res.json(policy);
  })
);

/**
 * POST /api/v1/projects/:projectId/alarm-policies
 * Create a new alarm trigger policy (Admin / Engineer only).
 */
router.post(
  '/projects/:projectId/alarm-policies',
  requireProjectAccess,
  requireProjectPermission('alarmPolicies.configure'),
  asyncHandler(async (req, res) => {
    if (req.projectRole === 'VIEWER') {
      throw new ApiError(403, 'Viewer permission is read-only. Cannot create alarm policies.');
    }

    const {
      name,
      code,
      category,
      scope,
      instrumentId,
      catalogCode,
      parameterCode,
      triggerLevels,
      status
    } = req.body;

    const policy = await createAlarmPolicy({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      name,
      code,
      category,
      scope,
      instrumentId,
      catalogCode,
      parameterCode,
      triggerLevels,
      status,
      user: req.auth
    });

    res.status(201).json(policy);
  })
);

/**
 * PUT /api/v1/projects/:projectId/alarm-policies/:id
 * Update an existing alarm trigger policy (Admin / Engineer only).
 */
router.put(
  '/projects/:projectId/alarm-policies/:id',
  requireProjectAccess,
  requireProjectPermission('alarmPolicies.configure'),
  asyncHandler(async (req, res) => {
    if (req.projectRole === 'VIEWER') {
      throw new ApiError(403, 'Viewer permission is read-only. Cannot update alarm policies.');
    }

    const policy = await updateAlarmPolicy({
      policyId: req.params.id,
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      updates: req.body,
      user: req.auth
    });

    res.json(policy);
  })
);

/**
 * PATCH /api/v1/projects/:projectId/alarm-policies/:id/status
 * Toggle policy active status (Admin / Engineer only).
 */
router.patch(
  '/projects/:projectId/alarm-policies/:id/status',
  requireProjectAccess,
  requireProjectPermission('alarmPolicies.activate'),
  asyncHandler(async (req, res) => {
    if (req.projectRole === 'VIEWER') {
      throw new ApiError(403, 'Viewer permission is read-only. Cannot modify alarm policies.');
    }

    const { status } = req.body;
    if (!status) throw new ApiError(400, 'status is required');

    const policy = await setAlarmPolicyStatus({
      policyId: req.params.id,
      projectId: req.params.projectId,
      status,
      user: req.auth
    });

    res.json(policy);
  })
);

export default router;
