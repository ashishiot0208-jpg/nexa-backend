import { AuditEvent } from '../models/index.js';

export async function audit({ req, organizationId, projectId, action, resourceType, resourceId, previousState, newState, reason, actorType, actorId }) {
  return AuditEvent.create({
    organizationId: organizationId || req?.auth?.organizationId,
    projectId,
    actorType: actorType || (req?.auth ? 'USER' : 'SYSTEM'),
    actorId: actorId || req?.auth?.userId,
    action,
    resourceType,
    resourceId: resourceId?.toString?.() || resourceId,
    previousState,
    newState,
    reason,
    correlationId: req?.correlationId,
    ip: req?.ip
  });
}
