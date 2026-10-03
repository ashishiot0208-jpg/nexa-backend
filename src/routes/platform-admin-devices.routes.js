import { Router } from 'express';
import { z } from 'zod';
import { DeviceCatalogue, AdminAudit, Sensor } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const deviceSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  model: z.string().optional(),
  supported_signal_types: z.array(z.string().min(1)).min(1),
  max_channels: z.number().int().positive().min(1),
  communication: z.string().min(1)
});

const generateUid = async () => {
  const lastDevice = await DeviceCatalogue.findOne().sort({ uid: -1 }).collation({ locale: 'en', numericOrdering: true });
  if (!lastDevice || !lastDevice.uid) {
    return 'DEV000001';
  }
  const match = lastDevice.uid.match(/^DEV(\d+)$/);
  if (match) {
    const nextNum = parseInt(match[1], 10) + 1;
    return `DEV${nextNum.toString().padStart(6, '0')}`;
  }
  return 'DEV000001'; // Fallback
};

router.get('/signals', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const activeSensors = await Sensor.find({ status: 'active' }).lean();
  const signals = [...new Set(
    activeSensors
      .map(s => s.signal_type)
      .filter(s => typeof s === 'string' && s.trim() !== '')
  )];
  res.json(signals);
}));

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const devices = await DeviceCatalogue.find().sort({ createdAt: -1 }).lean();
  res.json(devices);
}));

router.get('/:id', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const device = await DeviceCatalogue.findById(req.params.id).lean();
  if (!device) throw new ApiError(404, 'Device not found');
  res.json(device);
}));

router.post('/', requirePlatformAdminAuth, validate(deviceSchema), asyncHandler(async (req, res) => {
  const uniqueSignals = [...new Set(req.body.supported_signal_types)];
  if (uniqueSignals.length !== req.body.supported_signal_types.length) {
    throw new ApiError(400, 'Duplicate signal types are not allowed.');
  }
  
  // Use a retry loop for UID generation in case of race conditions
  let device = null;
  for (let i = 0; i < 5; i++) {
    try {
      const uid = await generateUid();
      device = await DeviceCatalogue.create({
        uid,
        name: req.body.name,
        type: req.body.type,
        model: req.body.model,
        supported_signal_types: uniqueSignals,
        max_channels: req.body.max_channels,
        communication: req.body.communication,
        status: 'active'
      });
      break;
    } catch (err) {
      if (err.code === 11000 && i < 4) {
        continue;
      }
      throw err;
    }
  }

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'DEVICE_CREATED',
    targetType: 'Device',
    targetId: device._id
  });

  res.status(201).json(device);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(deviceSchema), asyncHandler(async (req, res) => {
  const uniqueSignals = [...new Set(req.body.supported_signal_types)];
  if (uniqueSignals.length !== req.body.supported_signal_types.length) {
    throw new ApiError(400, 'Duplicate signal types are not allowed.');
  }

  const device = await DeviceCatalogue.findById(req.params.id);
  if (!device) throw new ApiError(404, 'Device not found');

  device.name = req.body.name;
  device.type = req.body.type;
  device.model = req.body.model;
  device.supported_signal_types = uniqueSignals;
  device.max_channels = req.body.max_channels;
  device.communication = req.body.communication;
  
  await device.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'DEVICE_UPDATED',
    targetType: 'Device',
    targetId: device._id
  });

  res.json(device);
}));

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const device = await DeviceCatalogue.findById(req.params.id);
  if (!device) throw new ApiError(404, 'Device not found');

  device.status = req.body.status;
  await device.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'active' ? 'DEVICE_ACTIVATED' : 'DEVICE_DEACTIVATED',
    targetType: 'Device',
    targetId: device._id
  });

  res.json(device);
}));

export default router;
