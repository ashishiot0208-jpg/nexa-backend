import { Router } from 'express';
import { z } from 'zod';
import { GatewayCatalogue, AdminAudit, DeviceCatalogue } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const gatewaySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  model: z.string().optional(),
  supported_device_communications: z.array(z.string().min(1)).min(1),
  backhaul: z.array(z.string().min(1)).min(1),
  max_devices: z.number().int().positive().min(1)
});

router.get('/communications', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const activeDevices = await DeviceCatalogue.find({ status: 'active' }).lean();
  const communications = [...new Set(
    activeDevices
      .map(d => d.communication)
      .filter(c => typeof c === 'string' && c.trim() !== '')
  )];
  res.json(communications);
}));

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const gateways = await GatewayCatalogue.find().sort({ createdAt: -1 }).lean();
  res.json(gateways);
}));

router.get('/:id', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const gateway = await GatewayCatalogue.findById(req.params.id).lean();
  if (!gateway) throw new ApiError(404, 'Gateway not found');
  res.json(gateway);
}));

router.post('/', requirePlatformAdminAuth, validate(gatewaySchema), asyncHandler(async (req, res) => {
  const uniqueCommunications = [...new Set(req.body.supported_device_communications)];
  if (uniqueCommunications.length !== req.body.supported_device_communications.length) {
    throw new ApiError(400, 'Duplicate communications are not allowed.');
  }

  const uniqueBackhaul = [...new Set(req.body.backhaul)];
  if (uniqueBackhaul.length !== req.body.backhaul.length) {
    throw new ApiError(400, 'Duplicate backhaul methods are not allowed.');
  }
  
  const gateway = await GatewayCatalogue.create({
    name: req.body.name,
    type: req.body.type,
    model: req.body.model,
    supported_device_communications: uniqueCommunications,
    backhaul: uniqueBackhaul,
    max_devices: req.body.max_devices,
    status: 'active'
  });

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'GATEWAY_CREATED',
    targetType: 'Gateway',
    targetId: gateway._id
  });

  res.status(201).json(gateway);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(gatewaySchema), asyncHandler(async (req, res) => {
  const uniqueCommunications = [...new Set(req.body.supported_device_communications)];
  if (uniqueCommunications.length !== req.body.supported_device_communications.length) {
    throw new ApiError(400, 'Duplicate communications are not allowed.');
  }

  const uniqueBackhaul = [...new Set(req.body.backhaul)];
  if (uniqueBackhaul.length !== req.body.backhaul.length) {
    throw new ApiError(400, 'Duplicate backhaul methods are not allowed.');
  }

  const gateway = await GatewayCatalogue.findById(req.params.id);
  if (!gateway) throw new ApiError(404, 'Gateway not found');

  gateway.name = req.body.name;
  gateway.type = req.body.type;
  gateway.model = req.body.model;
  gateway.supported_device_communications = uniqueCommunications;
  gateway.backhaul = uniqueBackhaul;
  gateway.max_devices = req.body.max_devices;
  
  await gateway.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'GATEWAY_UPDATED',
    targetType: 'Gateway',
    targetId: gateway._id
  });

  res.json(gateway);
}));

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const gateway = await GatewayCatalogue.findById(req.params.id);
  if (!gateway) throw new ApiError(404, 'Gateway not found');

  gateway.status = req.body.status;
  await gateway.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'active' ? 'GATEWAY_ACTIVATED' : 'GATEWAY_DEACTIVATED',
    targetType: 'Gateway',
    targetId: gateway._id
  });

  res.json(gateway);
}));

export default router;
