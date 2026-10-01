import { Router } from 'express';
import { z } from 'zod';
import { SensorType, AdminAudit } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const typeSchema = z.object({
  name: z.string().min(1)
});

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const types = await SensorType.find().sort({ createdAt: -1 }).lean();
  res.json(types);
}));

router.post('/', requirePlatformAdminAuth, validate(typeSchema), asyncHandler(async (req, res) => {
  const code = req.body.name.toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  
  const existing = await SensorType.findOne({ code });
  if (existing) {
    if (existing.status === 'inactive') {
      throw new ApiError(400, 'Sensor type already exists but is inactive.');
    }
    throw new ApiError(400, 'Sensor type already exists.');
  }
  
  const sensorType = await SensorType.create({
    code,
    name: req.body.name,
    status: 'active'
  });

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'SENSOR_TYPE_CREATED',
    targetType: 'SensorType',
    targetId: sensorType._id
  });

  res.status(201).json(sensorType);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(typeSchema), asyncHandler(async (req, res) => {
  const sensorType = await SensorType.findById(req.params.id);
  if (!sensorType) throw new ApiError(404, 'Sensor Type not found');

  sensorType.name = req.body.name;
  await sensorType.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'SENSOR_TYPE_UPDATED',
    targetType: 'SensorType',
    targetId: sensorType._id
  });

  res.json(sensorType);
}));

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const sensorType = await SensorType.findById(req.params.id);
  if (!sensorType) throw new ApiError(404, 'Sensor Type not found');

  sensorType.status = req.body.status;
  await sensorType.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'active' ? 'SENSOR_TYPE_ACTIVATED' : 'SENSOR_TYPE_DEACTIVATED',
    targetType: 'SensorType',
    targetId: sensorType._id
  });

  res.json(sensorType);
}));

export default router;
