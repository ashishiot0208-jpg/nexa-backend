import { Router } from 'express';
import { z } from 'zod';
import { DeviceCatalogue, DeviceType, AdminAudit, Sensor } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { evaluateDeviceBatch, deriveDisplayName } from '../utils/device-import.js';

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

// Bulk Import - Validate
router.post('/import/validate', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const devices = Array.isArray(req.body) ? req.body : req.body?.devices;
  if (!Array.isArray(devices)) {
    throw new ApiError(400, 'Import file must contain a JSON array of device objects.');
  }
  if (devices.length === 0) {
    throw new ApiError(400, 'Import file is empty. At least one device record is required.');
  }
  if (devices.length > 500) {
    throw new ApiError(400, 'Import batch exceeds maximum limit of 500 device records.');
  }

  const existingDevices = await DeviceCatalogue.find().lean();
  const existingDeviceTypes = await DeviceType.find().lean();
  const activeSensors = await Sensor.find({ status: 'active' }).lean();
  const activeSignalTypesSet = new Set(
    activeSensors
      .map(s => String(s.signal_type || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const evaluation = evaluateDeviceBatch(devices, existingDevices, existingDeviceTypes, activeSignalTypesSet);
  res.json(evaluation);
}));

// Bulk Import - Create Missing Types
router.post('/import/create-types', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const types = Array.isArray(req.body) ? req.body : req.body?.types;
  if (!Array.isArray(types) || types.length === 0) {
    throw new ApiError(400, 'A non-empty array of device types is required.');
  }

  const createdTypes = [];
  for (const item of types) {
    const rawCode = String(item.code || item.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    const name = String(item.name || '').trim() || deriveDisplayName(rawCode);
    if (!rawCode || !name) continue;

    const existing = await DeviceType.findOne({ code: rawCode });
    if (existing) {
      // Do not silently reactivate if inactive
      continue;
    }

    const created = await DeviceType.create({
      code: rawCode,
      name,
      status: 'active'
    });

    await AdminAudit.create({
      adminId: req.adminAuth.adminId,
      action: 'DEVICE_TYPE_CREATED',
      targetType: 'DeviceType',
      targetId: created._id,
      metadata: { source: 'bulk_device_import' }
    });

    createdTypes.push(created);
  }

  res.status(201).json({ created: createdTypes });
}));

// Bulk Import - Execute
router.post('/import', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const devices = Array.isArray(req.body) ? req.body : req.body?.devices;
  if (!Array.isArray(devices)) {
    throw new ApiError(400, 'Import file must contain a JSON array of device objects.');
  }
  if (devices.length === 0) {
    throw new ApiError(400, 'Import file is empty. At least one device record is required.');
  }
  if (devices.length > 500) {
    throw new ApiError(400, 'Import batch exceeds maximum limit of 500 device records.');
  }

  // Revalidate everything on backend
  const existingDevices = await DeviceCatalogue.find().lean();
  const existingDeviceTypes = await DeviceType.find().lean();
  const activeSensors = await Sensor.find({ status: 'active' }).lean();
  const activeSignalTypesSet = new Set(
    activeSensors
      .map(s => String(s.signal_type || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const evaluation = evaluateDeviceBatch(devices, existingDevices, existingDeviceTypes, activeSignalTypesSet);

  const validRows = evaluation.rows.filter(r => r.status === 'VALID');
  const skippedDuplicates = evaluation.rows.filter(r => r.status === 'DUPLICATE').map(r => ({ name: r.name, issue: r.issue }));
  const invalidRecords = evaluation.rows.filter(r => r.status === 'INVALID' || r.status === 'INVALID SIGNAL' || r.status === 'MISSING TYPE' || r.status === 'TYPE INACTIVE').map(r => ({ name: r.name, issue: r.issue }));

  const createdDevices = [];
  for (const row of validRows) {
    let device = null;
    for (let i = 0; i < 5; i++) {
      try {
        const uid = await generateUid();
        device = await DeviceCatalogue.create({
          uid,
          name: row.cleanData.name,
          type: row.cleanData.type,
          model: row.cleanData.model,
          supported_signal_types: row.cleanData.supported_signal_types,
          max_channels: row.cleanData.max_channels,
          communication: row.cleanData.communication,
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
    if (device) {
      createdDevices.push(device);
      await AdminAudit.create({
        adminId: req.adminAuth.adminId,
        action: 'DEVICE_CREATED',
        targetType: 'Device',
        targetId: device._id,
        metadata: { source: 'bulk_device_import' }
      });
    }
  }

  // Bulk audit event
  if (createdDevices.length > 0 || skippedDuplicates.length > 0 || invalidRecords.length > 0) {
    await AdminAudit.create({
      adminId: req.adminAuth.adminId,
      action: 'DEVICES_IMPORTED',
      targetType: 'Device',
      metadata: {
        importedCount: createdDevices.length,
        skippedCount: skippedDuplicates.length,
        failedCount: invalidRecords.length
      }
    });
  }

  res.status(201).json({
    summary: {
      total: evaluation.rows.length,
      importedCount: createdDevices.length,
      skippedCount: skippedDuplicates.length,
      failedCount: invalidRecords.length
    },
    imported: createdDevices.map(d => ({ _id: d._id, uid: d.uid, name: d.name })),
    skipped: skippedDuplicates,
    failed: invalidRecords
  });
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
