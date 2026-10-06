import { Router } from 'express';
import { z } from 'zod';
import { Sensor, SensorType, AdminAudit } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { evaluateSensorBatch, deriveDisplayName } from '../utils/sensor-import.js';

const router = Router();

const channelSchema = z.object({
  measurement: z.string().min(1),
  unit: z.string().min(1),
  range_min: z.number().nullable().optional(),
  range_max: z.number().nullable().optional(),
  resolution_value: z.number().min(0).nullable().optional(),
  resolution_unit: z.string().nullable().optional(),
  accuracy_value: z.number().min(0).nullable().optional(),
  accuracy_unit: z.string().nullable().optional()
}).refine(data => {
  if (data.range_min != null && data.range_max != null) {
    return data.range_min <= data.range_max;
  }
  return true;
}, {
  message: "range_min must be <= range_max",
  path: ["range_min"]
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

// Bulk Import - Validate
router.post('/import/validate', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const sensors = Array.isArray(req.body) ? req.body : req.body?.sensors;
  if (!Array.isArray(sensors)) {
    throw new ApiError(400, 'Import file must contain a JSON array of sensor objects.');
  }
  if (sensors.length === 0) {
    throw new ApiError(400, 'Import file is empty. At least one sensor record is required.');
  }
  if (sensors.length > 500) {
    throw new ApiError(400, 'Import batch exceeds maximum limit of 500 sensor records.');
  }

  const existingSensors = await Sensor.find().lean();
  const existingSensorTypes = await SensorType.find().lean();

  const evaluation = evaluateSensorBatch(sensors, existingSensors, existingSensorTypes);
  res.json(evaluation);
}));

// Bulk Import - Create Missing Types
router.post('/import/create-types', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const types = Array.isArray(req.body) ? req.body : req.body?.types;
  if (!Array.isArray(types) || types.length === 0) {
    throw new ApiError(400, 'A non-empty array of sensor types is required.');
  }

  const createdTypes = [];
  for (const item of types) {
    const rawCode = String(item.code || item.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    const name = String(item.name || '').trim() || deriveDisplayName(rawCode);
    if (!rawCode || !name) continue;

    const existing = await SensorType.findOne({ code: rawCode });
    if (existing) {
      // Do not silently reactivate if inactive
      continue;
    }

    const created = await SensorType.create({
      code: rawCode,
      name,
      status: 'active'
    });

    await AdminAudit.create({
      adminId: req.adminAuth.adminId,
      action: 'SENSOR_TYPE_CREATED',
      targetType: 'SensorType',
      targetId: created._id,
      metadata: { source: 'bulk_sensor_import' }
    });

    createdTypes.push(created);
  }

  res.status(201).json({ created: createdTypes });
}));

// Bulk Import - Execute
router.post('/import', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const sensors = Array.isArray(req.body) ? req.body : req.body?.sensors;
  if (!Array.isArray(sensors)) {
    throw new ApiError(400, 'Import file must contain a JSON array of sensor objects.');
  }
  if (sensors.length === 0) {
    throw new ApiError(400, 'Import file is empty. At least one sensor record is required.');
  }
  if (sensors.length > 500) {
    throw new ApiError(400, 'Import batch exceeds maximum limit of 500 sensor records.');
  }

  // Revalidate everything on backend
  const existingSensors = await Sensor.find().lean();
  const existingSensorTypes = await SensorType.find().lean();

  const evaluation = evaluateSensorBatch(sensors, existingSensors, existingSensorTypes);

  const validRows = evaluation.rows.filter(r => r.status === 'VALID');
  const skippedDuplicates = evaluation.rows.filter(r => r.status === 'DUPLICATE').map(r => ({ name: r.name, issue: r.issue }));
  const invalidRecords = evaluation.rows.filter(r => r.status === 'INVALID' || r.status === 'MISSING TYPE' || r.status === 'TYPE INACTIVE').map(r => ({ name: r.name, issue: r.issue }));

  const createdSensors = [];
  for (const row of validRows) {
    // Generate Sensor UID via existing Counter mechanism in pre-save hook
    const doc = await Sensor.create({
      name: row.cleanData.name,
      type: row.cleanData.type,
      model: row.cleanData.model,
      signal_type: row.cleanData.signal_type,
      channels: row.cleanData.channels,
      status: 'active'
    });
    createdSensors.push(doc);
  }

  // Audit event
  if (createdSensors.length > 0 || skippedDuplicates.length > 0 || invalidRecords.length > 0) {
    await AdminAudit.create({
      adminId: req.adminAuth.adminId,
      action: 'SENSORS_IMPORTED',
      targetType: 'Sensor',
      metadata: {
        importedCount: createdSensors.length,
        skippedCount: skippedDuplicates.length,
        failedCount: invalidRecords.length
      }
    });
  }

  res.status(201).json({
    summary: {
      total: evaluation.rows.length,
      importedCount: createdSensors.length,
      skippedCount: skippedDuplicates.length,
      failedCount: invalidRecords.length
    },
    imported: createdSensors.map(s => ({ _id: s._id, uid: s.uid, name: s.name })),
    skipped: skippedDuplicates,
    failed: invalidRecords
  });
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
