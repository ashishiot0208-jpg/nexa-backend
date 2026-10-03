import { Router } from 'express';
import { z } from 'zod';
import { DeviceType, AdminAudit } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const deviceTypeSchema = z.object({
  name: z.string().min(1)
});

const generateCode = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
};

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const types = await DeviceType.find().sort({ createdAt: -1 }).lean();
  res.json(types);
}));

router.post('/', requirePlatformAdminAuth, validate(deviceTypeSchema), asyncHandler(async (req, res) => {
  const code = generateCode(req.body.name);
  
  const existing = await DeviceType.findOne({ code });
  if (existing) {
    throw new ApiError(400, 'A device type with this generated code already exists.');
  }

  const deviceType = await DeviceType.create({
    code,
    name: req.body.name,
    status: 'active'
  });

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'DEVICE_TYPE_CREATED',
    targetType: 'DeviceType',
    targetId: deviceType._id
  });

  res.status(201).json(deviceType);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(deviceTypeSchema), asyncHandler(async (req, res) => {
  const deviceType = await DeviceType.findById(req.params.id);
  if (!deviceType) throw new ApiError(404, 'Device Type not found');

  deviceType.name = req.body.name;
  await deviceType.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'DEVICE_TYPE_UPDATED',
    targetType: 'DeviceType',
    targetId: deviceType._id
  });

  res.json(deviceType);
}));

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const deviceType = await DeviceType.findById(req.params.id);
  if (!deviceType) throw new ApiError(404, 'Device Type not found');

  deviceType.status = req.body.status;
  await deviceType.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'active' ? 'DEVICE_TYPE_ACTIVATED' : 'DEVICE_TYPE_DEACTIVATED',
    targetType: 'DeviceType',
    targetId: deviceType._id
  });

  res.json(deviceType);
}));

export default router;
