import { Router } from 'express';
import { z } from 'zod';
import { BaselineVersion, CalibrationVersion, Device, Instrument, InstrumentCatalog, SensorChannel } from '../models/index.js';
import { requireAuth, requireProjectAccess, ensureProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from '../services/audit.service.js';
import { randomToken, sha256 } from '../utils/crypto.js';

const router = Router(); router.use(requireAuth);

router.get('/projects/:projectId/instruments', requireProjectAccess, asyncHandler(async (req, res) => {
  const rows = await Instrument.find({ projectId: req.params.projectId }).sort({ name: 1 }).lean();
  const withChannels = await Promise.all(rows.map(async (x) => ({ ...x, channels: await SensorChannel.find({ instrumentId: x._id }).lean() })));
  res.json(withChannels);
}));

router.post('/projects/:projectId/instruments', requireProjectAccess, asyncHandler(async (req, res) => {
  const catalog = await InstrumentCatalog.findOne({ code: String(req.body.catalogCode || '').toUpperCase() }); if (!catalog) throw new ApiError(400, 'Instrument catalogue item not found');
  const instrument = await Instrument.create({ organizationId: req.auth.organizationId, projectId: req.params.projectId, siteId: req.body.siteId, zoneId: req.body.zoneId, catalogCode: catalog.code, name: req.body.name || catalog.name, code: req.body.code, serial: req.body.serial, coordinates: req.body.coordinates, orientationDeg: req.body.orientationDeg, depthM: req.body.depthM, status: 'PLANNED', metadata: req.body.metadata || {} });
  for (const ch of req.body.channels || catalog.defaultChannels || []) await SensorChannel.create({ organizationId: req.auth.organizationId, projectId: req.params.projectId, instrumentId: instrument._id, deviceId: ch.deviceId, code: ch.code, sourceField: ch.sourceField || ch.code, parameterCode: ch.parameterCode, rawUnit: ch.rawUnit, engineeringUnit: ch.engineeringUnit, sampleIntervalSec: ch.sampleIntervalSec || 900, calibration: ch.calibration || { scale:1,offset:0,version:1 }, baseline: ch.baseline || { value:0,version:1 }, qualityConfig: ch.qualityConfig || {} });
  await audit({ req, projectId: req.params.projectId, action: 'INSTRUMENT_CREATED', resourceType: 'Instrument', resourceId: instrument._id, newState: instrument.toObject() });
  res.status(201).json(instrument);
}));

router.get('/instruments/:id', asyncHandler(async (req, res) => {
  const instrument = await Instrument.findOne({ _id: req.params.id, organizationId: req.auth.organizationId }).lean(); if (!instrument) throw new ApiError(404, 'Instrument not found');
  await ensureProjectAccess(req, instrument.projectId);
  const channels = await SensorChannel.find({ instrumentId: instrument._id }).lean(); res.json({ instrument, channels });
}));

router.post('/instruments/:id/calibrations', asyncHandler(async (req, res) => {
  const instrument = await Instrument.findOne({ _id: req.params.id, organizationId: req.auth.organizationId }); if (!instrument) throw new ApiError(404, 'Instrument not found');
  await ensureProjectAccess(req, instrument.projectId);
  const channel = req.body.channelId ? await SensorChannel.findById(req.body.channelId) : null;
  const version = await CalibrationVersion.countDocuments({ instrumentId: instrument._id, channelId: req.body.channelId || null }) + 1;
  const doc = await CalibrationVersion.create({ projectId: instrument.projectId, instrumentId: instrument._id, channelId: req.body.channelId, version, coefficients: req.body.coefficients || { scale:1, offset:0 }, certificateDocumentId: req.body.certificateDocumentId, reason: req.body.reason, createdBy: req.auth.userId });
  if (channel) { channel.calibration = { scale: Number(req.body.coefficients?.scale ?? 1), offset: Number(req.body.coefficients?.offset ?? 0), version }; await channel.save(); }
  await audit({ req, projectId: instrument.projectId, action: 'CALIBRATION_CREATED', resourceType: 'CalibrationVersion', resourceId: doc._id, newState: doc.toObject(), reason: req.body.reason }); res.status(201).json(doc);
}));

router.post('/instruments/:id/baselines', asyncHandler(async (req, res) => {
  const instrument = await Instrument.findOne({ _id: req.params.id, organizationId: req.auth.organizationId }); if (!instrument) throw new ApiError(404, 'Instrument not found');
  await ensureProjectAccess(req, instrument.projectId);
  const channel = req.body.channelId ? await SensorChannel.findById(req.body.channelId) : null;
  const version = await BaselineVersion.countDocuments({ instrumentId: instrument._id, channelId: req.body.channelId || null }) + 1;
  const doc = await BaselineVersion.create({ projectId: instrument.projectId, instrumentId: instrument._id, channelId: req.body.channelId, version, value: Number(req.body.value), method: req.body.method || 'SINGLE_POINT', windowStart: req.body.windowStart, windowEnd: req.body.windowEnd, reason: req.body.reason, createdBy: req.auth.userId });
  if (channel) { channel.baseline = { value: Number(req.body.value), capturedAt: new Date(), version }; await channel.save(); }
  await audit({ req, projectId: instrument.projectId, action: 'BASELINE_CREATED', resourceType: 'BaselineVersion', resourceId: doc._id, newState: doc.toObject(), reason: req.body.reason }); res.status(201).json(doc);
}));

router.post('/instruments/:id/commission', asyncHandler(async (req, res) => {
  const instrument = await Instrument.findOne({ _id: req.params.id, organizationId: req.auth.organizationId }); if (!instrument) throw new ApiError(404, 'Instrument not found');
  await ensureProjectAccess(req, instrument.projectId);
  const channels = await SensorChannel.find({ instrumentId: instrument._id }).lean(); if (!channels.length) throw new ApiError(409, 'Instrument has no channels');
  instrument.status = 'COMMISSIONED'; instrument.commissionedAt = new Date(); instrument.commissionedBy = req.auth.userId; await instrument.save();
  await audit({ req, projectId: instrument.projectId, action: 'INSTRUMENT_COMMISSIONED', resourceType: 'Instrument', resourceId: instrument._id, newState: instrument.toObject(), reason: req.body.comment }); res.json(instrument);
}));

router.get('/projects/:projectId/devices', requireProjectAccess, asyncHandler(async (req, res) => res.json(await Device.find({ projectId: req.params.projectId }).sort({ name: 1 }).lean())));
router.post('/projects/:projectId/devices', requireProjectAccess, asyncHandler(async (req, res) => {
  const key = `gxn_${randomToken(16)}`; const doc = await Device.create({ organizationId: req.auth.organizationId, projectId: req.params.projectId, deviceId: req.body.deviceId, name: req.body.name, deviceType: req.body.deviceType || 'LOGGER', transport: req.body.transport || '4G', firmware: req.body.firmware, apiKeyHash: sha256(key), apiKeyPrefix: key.slice(0,10), expectedIntervalSec: req.body.expectedIntervalSec || 900, status: 'PLANNED' });
  await audit({ req, projectId: req.params.projectId, action: 'DEVICE_CREATED', resourceType: 'Device', resourceId: doc._id, newState: doc.toObject() }); res.status(201).json({ device: doc, apiKey: key });
}));
router.post('/devices/:id/rotate-key', asyncHandler(async (req, res) => { const device = await Device.findOne({ _id: req.params.id, organizationId: req.auth.organizationId }); if (!device) throw new ApiError(404,'Device not found'); await ensureProjectAccess(req, device.projectId); const key=`gxn_${randomToken(16)}`; device.apiKeyHash=sha256(key); device.apiKeyPrefix=key.slice(0,10); await device.save(); await audit({ req, projectId:device.projectId, action:'DEVICE_KEY_ROTATED', resourceType:'Device', resourceId:device._id }); res.json({ deviceId:device.deviceId, apiKey:key }); }));
router.patch('/channels/:id/device', asyncHandler(async (req, res) => { const ch=await SensorChannel.findOne({_id:req.params.id,organizationId:req.auth.organizationId}); if(!ch) throw new ApiError(404,'Channel not found'); await ensureProjectAccess(req, ch.projectId); ch.deviceId=req.body.deviceId||undefined; await ch.save(); res.json(ch); }));

export default router;
