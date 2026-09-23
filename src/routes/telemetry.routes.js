import { Router } from 'express';
import mongoose from 'mongoose';
import { Device, DerivedReading, LatestState, RawReading } from '../models/index.js';
import { requireDevice } from '../middleware/device-auth.js';
import { requireAuth, requireProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { processTelemetry } from '../services/telemetry.service.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

router.post('/telemetry/ingest', requireDevice, asyncHandler(async (req, res) => {
  const result = await processTelemetry({ device: req.device, payload: req.body, emit: req.app.locals.emitEvent });
  res.status(202).json({ status: 'ACCEPTED', ...result });
}));

router.post('/projects/:projectId/telemetry/manual', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => {
  const device = await Device.findOne({ _id: req.body.deviceMongoId, projectId: req.params.projectId, organizationId: req.auth.organizationId });
  if (!device) throw new ApiError(404, 'Device not found');
  const result = await processTelemetry({ device, payload: req.body.payload || req.body, emit: req.app.locals.emitEvent });
  res.status(202).json({ status: 'ACCEPTED', ...result });
}));

router.get('/projects/:projectId/telemetry', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => {
  const mode = String(req.query.mode || 'processed').toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 3600000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new ApiError(400, 'Invalid bounded time range');
  const cursor = decodeCursor(req.query.cursor);
  const base = { projectId: req.params.projectId };
  if (req.query.instrumentId) base.instrumentId = req.query.instrumentId;
  if (req.query.quality) base.quality = { $in: String(req.query.quality).split(',') };
  if (mode === 'raw') {
    base.sampleTime = { $gte: from, $lte: to };
    if (cursor?.t) base.sampleTime.$lt = new Date(cursor.t);
    if (req.query.channelId) base.channelId = req.query.channelId;
    const rows = await RawReading.find(base).sort({ sampleTime: -1, _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit; const page = rows.slice(0, limit);
    return res.json({ items: page, nextCursor: hasMore ? encodeCursor({ observedAt: page.at(-1).sampleTime, _id: page.at(-1)._id }) : null });
  }
  base.observedAt = { $gte: from, $lte: to };
  if (cursor?.t) base.observedAt.$lt = new Date(cursor.t);
  if (req.query.parameter) base.parameterCode = { $in: String(req.query.parameter).split(',') };
  const rows = await DerivedReading.find(base).sort({ observedAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit; const page = rows.slice(0, limit);
  res.json({ items: page, nextCursor: hasMore && page.length ? encodeCursor(page.at(-1)) : null });
}));

router.get('/projects/:projectId/trends', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 3600000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const parameters = String(req.query.parameter || '').split(',').filter(Boolean);
  if (!parameters.length) throw new ApiError(400, 'parameter query is required');
  const bucket = String(req.query.bucket || '15m');
  const units = { '5m': { unit: 'minute', binSize: 5 }, '15m': { unit: 'minute', binSize: 15 }, '1h': { unit: 'hour', binSize: 1 }, '1d': { unit: 'day', binSize: 1 } };
  const b = units[bucket] || units['15m'];
  const match = { projectId: new mongoose.Types.ObjectId(req.params.projectId), observedAt: { $gte: from, $lte: to }, parameterCode: { $in: parameters } };
  if (req.query.instrumentId) match.instrumentId = new mongoose.Types.ObjectId(String(req.query.instrumentId));
  const data = await DerivedReading.aggregate([
    { $match: match },
    { $group: { _id: { parameterCode: '$parameterCode', instrumentId: '$instrumentId', bucket: { $dateTrunc: { date: '$observedAt', unit: b.unit, binSize: b.binSize } } }, avg: { $avg: '$value' }, min: { $min: '$value' }, max: { $max: '$value' }, count: { $sum: 1 }, unit: { $last: '$unit' } } },
    { $sort: { '_id.bucket': 1 } }
  ]);
  res.json({ bucket, from, to, items: data.map((x) => ({ parameterCode: x._id.parameterCode, instrumentId: x._id.instrumentId, time: x._id.bucket, avg: x.avg, min: x.min, max: x.max, count: x.count, unit: x.unit })) });
}));


router.get('/projects/:projectId/telemetry/export.csv', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 3600000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const q = { projectId: req.params.projectId, observedAt: { $gte: from, $lte: to } };
  if (req.query.instrumentId) q.instrumentId = req.query.instrumentId;
  if (req.query.parameter) q.parameterCode = { $in: String(req.query.parameter).split(',') };
  const rows = await DerivedReading.find(q).sort({ observedAt: 1 }).limit(100000).lean();
  const esc = (v) => `"${String(v ?? '').replaceAll('"','""')}"`;
  const lines = ['observedAt,instrumentId,parameterCode,value,unit,quality,ratePerHour,deltaFromBaseline'];
  for (const r of rows) lines.push([r.observedAt.toISOString(),r.instrumentId,r.parameterCode,r.value,r.unit,r.quality,r.ratePerHour,r.deltaFromBaseline].map(esc).join(','));
  res.setHeader('content-type','text/csv; charset=utf-8');
  res.setHeader('content-disposition',`attachment; filename="telemetry-${req.params.projectId}.csv"`);
  res.send(lines.join('\n'));
}));

router.get('/projects/:projectId/latest-state', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => res.json(await LatestState.find({ projectId: req.params.projectId }).sort({ observedAt: -1 }).lean())));
export default router;
