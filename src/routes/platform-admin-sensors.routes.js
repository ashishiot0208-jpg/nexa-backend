import { Router } from 'express';
import { z } from 'zod';
import { Sensor, AdminAudit } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const channelSchema = z.object({
  measurement: z.string().min(1),
  unit: z.string().min(1),
  range: z.string().optional(),
  resolution: z.string().optional(),
  accuracy: z.string().optional()
});

const sensorSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  model: z.string().optional(),
  signal_type: z.string().min(1),
  channels: z.array(channelSchema).min(1)
});

const checkDuplicateMeasurements = (channels) => {
  const measurements = channels.map(c => c.measurement.toLowerCase());
  const unique = new Set(measurements);
  if (unique.size !== measurements.length) {
    throw new ApiError(400, 'Duplicate measurement names inside the same sensor are not allowed.');
  }
};

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const sensors = await Sensor.find().sort({ createdAt: -1 }).lean();
  res.json(sensors);
}));

router.get('/:id', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const sensor = await Sensor.findById(req.params.id).lean();
  if (!sensor) throw new ApiError(404, 'Sensor not found');
  res.json(sensor);
}));

router.post('/', requirePlatformAdminAuth, validate(sensorSchema), asyncHandler(async (req, res) => {
  checkDuplicateMeasurements(req.body.channels);
  
  const sensor = await Sensor.create({
    name: req.body.name,
    type: req.body.type,
    model: req.body.model,
    signal_type: req.body.signal_type,
    channels: req.body.channels,
    status: 'active'
  });

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'SENSOR_CREATED',
    targetType: 'Sensor',
    targetId: sensor._id
  });

  res.status(201).json(sensor);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(sensorSchema), asyncHandler(async (req, res) => {
  checkDuplicateMeasurements(req.body.channels);
  
  const sensor = await Sensor.findById(req.params.id);
  if (!sensor) throw new ApiError(404, 'Sensor not found');

  sensor.name = req.body.name;
  sensor.type = req.body.type;
  sensor.model = req.body.model;
  sensor.signal_type = req.body.signal_type;
  sensor.channels = req.body.channels;
  
  await sensor.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'SENSOR_UPDATED',
    targetType: 'Sensor',
    targetId: sensor._id
  });

  res.json(sensor);
}));

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const sensor = await Sensor.findById(req.params.id);
  if (!sensor) throw new ApiError(404, 'Sensor not found');

  sensor.status = req.body.status;
  await sensor.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'active' ? 'SENSOR_ACTIVATED' : 'SENSOR_DEACTIVATED',
    targetType: 'Sensor',
    targetId: sensor._id
  });

  res.json(sensor);
}));

export default router;
