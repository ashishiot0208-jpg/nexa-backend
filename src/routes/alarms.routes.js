import { Router } from 'express';
import { Alarm, AlarmEvent } from '../models/index.js';
import { requireAuth, requireProjectAccess, ensureProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  transitionAlarm,
  listAlarms,
  getAlarm,
  acknowledgeAlarm,
  resolveAlarm
} from '../services/alarm.service.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();
router.use(requireAuth);

// =========================================================================
// CANONICAL PROJECT-SCOPED ALARM ENDPOINTS (Phase C6A)
// =========================================================================

/**
 * GET /api/v1/projects/:projectId/alarms
 * List alarms for a project with optional filters: status, category, instrumentId, severity
 */
router.get(
  '/projects/:projectId/alarms',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const { status, category, instrumentId, severity, lifecycleVersion, includeLegacy, limit, skip } = req.query;

    const alarms = await listAlarms({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      status,
      category,
      instrumentId,
      severity,
      lifecycleVersion,
      includeLegacy: includeLegacy === 'true',
      limit,
      skip
    });

    res.json(alarms);
  })
);

/**
 * GET /api/v1/projects/:projectId/alarms/:alarmId
 * Retrieve single alarm and its audit/lifecycle events.
 */
router.get(
  '/projects/:projectId/alarms/:alarmId',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const result = await getAlarm({
      alarmId: req.params.alarmId,
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId
    });

    res.json(result);
  })
);

/**
 * POST /api/v1/projects/:projectId/alarms/:alarmId/acknowledge
 * PATCH /api/v1/projects/:projectId/alarms/:alarmId/acknowledge
 * Acknowledge an OPEN alarm (Admin / Engineer / Operator; Viewer rejected).
 */
const handleAcknowledge = asyncHandler(async (req, res) => {
  if (req.projectRole === 'VIEWER') {
    throw new ApiError(403, 'Viewer permission is read-only. Cannot modify alarms.');
  }

  const updated = await acknowledgeAlarm({
    alarmId: req.params.alarmId,
    projectId: req.params.projectId,
    organizationId: req.auth.organizationId,
    user: req.auth,
    userRole: req.projectRole,
    comment: req.body?.comment,
    req,
    emit: req.app?.locals?.emitEvent || (() => {})
  });

  res.json(updated);
});

router.post('/projects/:projectId/alarms/:alarmId/acknowledge', requireProjectAccess, handleAcknowledge);
router.patch('/projects/:projectId/alarms/:alarmId/acknowledge', requireProjectAccess, handleAcknowledge);

/**
 * POST /api/v1/projects/:projectId/alarms/:alarmId/resolve
 * PATCH /api/v1/projects/:projectId/alarms/:alarmId/resolve
 * Resolve an alarm (Admin / Engineer / Operator; Viewer rejected).
 */
const handleResolve = asyncHandler(async (req, res) => {
  if (req.projectRole === 'VIEWER') {
    throw new ApiError(403, 'Viewer permission is read-only. Cannot modify alarms.');
  }

  const updated = await resolveAlarm({
    alarmId: req.params.alarmId,
    projectId: req.params.projectId,
    organizationId: req.auth.organizationId,
    user: req.auth,
    userRole: req.projectRole,
    comment: req.body?.comment,
    resolutionReason: req.body?.resolutionReason || req.body?.resolutionCode,
    req,
    emit: req.app?.locals?.emitEvent || (() => {})
  });

  res.json(updated);
});

router.post('/projects/:projectId/alarms/:alarmId/resolve', requireProjectAccess, handleResolve);
router.patch('/projects/:projectId/alarms/:alarmId/resolve', requireProjectAccess, handleResolve);

// =========================================================================
// LEGACY ALARM ENDPOINTS (Preserved for backward compatibility)
// =========================================================================

router.get(
  '/alarms/:id',
  asyncHandler(async (req, res) => {
    const alarm = await Alarm.findOne({ _id: req.params.id, organizationId: req.auth.organizationId }).lean();
    if (!alarm) throw new ApiError(404, 'Alarm not found');
    await ensureProjectAccess(req, alarm.projectId);
    const events = await AlarmEvent.find({ alarmId: alarm._id }).sort({ createdAt: 1 }).lean();
    res.json({ alarm, events });
  })
);

router.post(
  '/alarms/:id/transition',
  asyncHandler(async (req, res) =>
    res.json(
      await transitionAlarm({
        alarmId: req.params.id,
        toState: req.body.toState,
        comment: req.body.comment,
        actionCode: req.body.actionCode,
        resolutionCode: req.body.resolutionCode,
        ownerId: req.body.ownerId,
        req,
        emit: req.app.locals.emitEvent
      })
    )
  )
);

router.post(
  '/alarms/:id/acknowledge',
  asyncHandler(async (req, res) =>
    res.json(
      await transitionAlarm({
        alarmId: req.params.id,
        toState: 'ACKNOWLEDGED',
        comment: req.body.comment || 'Acknowledged',
        req,
        emit: req.app.locals.emitEvent
      })
    )
  )
);

router.post(
  '/alarms/:id/actions',
  asyncHandler(async (req, res) =>
    res.json(
      await transitionAlarm({
        alarmId: req.params.id,
        toState: req.body.toState || 'ACTION_IN_PROGRESS',
        comment: req.body.comment || 'Action started',
        actionCode: req.body.actionCode,
        req,
        emit: req.app.locals.emitEvent
      })
    )
  )
);

export default router;
