import { Alarm, AlarmEvent } from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from './audit.service.js';
import { ensureProjectAccess } from '../middleware/auth.js';

const allowed = {
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
  if (!(allowed[alarm.state] || []).includes(toState)) throw new ApiError(409, `Transition ${alarm.state} -> ${toState} is not allowed`);
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
