import { Router } from 'express';
import mongoose from 'mongoose';
import { Device, DerivedReading, LatestState, RawReading } from '../models/index.js';
import { requireDevice } from '../middleware/device-auth.js';
import { requireAuth, requireProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ingestTelemetry, processTelemetry } from '../services/telemetry.service.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

router.post('/telemetry/ingest', asyncHandler(async (req, res) => {
  const result = await ingestTelemetry(req.body, { emit: req.app.locals.emitEvent });
  res.status(200).json(result);
}));

router.post('/projects/:projectId/telemetry/manual', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => {
  const device = await Device.findOne({ _id: req.body.deviceMongoId, projectId: req.params.projectId, organizationId: req.auth.organizationId });
  if (!device) throw new ApiError(404, 'Device not found');
  const payload = req.body.payload || req.body;
  const result = await ingestTelemetry({ ...payload, deviceCode: device.deviceId }, { emit: req.app.locals.emitEvent });
  res.status(200).json(result);
}));

function formatHistoryRow(r) {
  const rawReading = r.rawReadingId;
  const instrument = r.instrumentId;
  const channel = r.channelId;
  const source = rawReading?.sourceMetadata?.source || r.metadata?.source || 'SIMULATOR';

  const isTemp = r.parameterCode?.toLowerCase().includes('temp');
  const isBaselineApplicable = !isTemp && (channel?.baseline?.configured === true || (r.deltaFromBaseline !== null && r.deltaFromBaseline !== undefined && !isTemp));
  const deltaFromBaseline = isBaselineApplicable && r.deltaFromBaseline !== null && r.deltaFromBaseline !== undefined
    ? r.deltaFromBaseline
    : null;

  return {
    _id: r._id,
    timestamp: r.observedAt,
    observedAt: r.observedAt,
    instrumentId: instrument?._id || r.instrumentId,
    instrumentCode: instrument?.code || '—',
    instrumentName: instrument?.name || '—',
    instrumentTypeName: instrument?.typeName || '—',
    channelId: channel?._id || r.channelId,
    channelCode: channel?.code || r.parameterCode,
    channelLabel: channel?.label || r.parameterCode,
    parameterCode: r.parameterCode,
    rawValue: (rawReading && rawReading.rawValue !== null && rawReading.rawValue !== undefined)
      ? rawReading.rawValue
      : null,
    rawUnit: rawReading?.rawUnit || channel?.rawUnit || r.unit || '',
    value: r.value,
    engineeringValue: r.value,
    unit: r.unit || channel?.engineeringUnit || '',
    deltaFromBaseline,
    ratePerHour: r.ratePerHour,
    quality: r.quality || 'VALID',
    qualityReasons: r.qualityReasons || [],
    source,
    rawReadingId: rawReading?._id || null
  };
}

export function resolveTelemetryTimeRange(query) {
  const to = query.to ? new Date(String(query.to)) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw new ApiError(400, 'Invalid to timestamp');
  }

  const periodRaw = String(query.period || '').trim().toLowerCase();
  let from = null;

  if (periodRaw === 'all') {
    from = null;
  } else if (periodRaw === '7d' || periodRaw === '7 days' || periodRaw === '7_days') {
    from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (periodRaw === '30d' || periodRaw === '30 days' || periodRaw === '30_days') {
    from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (periodRaw === '90d' || periodRaw === '90 days' || periodRaw === '90_days') {
    from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else if (periodRaw === '24h' || periodRaw === '24 hours' || periodRaw === '1 day') {
    from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  } else if (periodRaw === '6h' || periodRaw === '6 hours') {
    from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
  } else if (periodRaw === '1h' || periodRaw === '1 hour') {
    from = new Date(to.getTime() - 60 * 60 * 1000);
  } else if (query.from) {
    from = new Date(String(query.from));
    if (Number.isNaN(from.getTime())) {
      throw new ApiError(400, 'Invalid from timestamp');
    }
  } else {
    from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  if (from && from > to) {
    throw new ApiError(400, 'Invalid bounded time range: from > to');
  }

  return { from, to };
}

router.get('/projects/:projectId/telemetry', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => {
  const mode = String(req.query.mode || 'processed').toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const page = req.query.page ? Math.max(1, Number(req.query.page)) : null;

  const { from, to } = resolveTelemetryTimeRange(req.query);
  const timeQuery = from ? { $gte: from, $lte: to } : { $lte: to };

  const cursor = decodeCursor(req.query.cursor);
  const base = { projectId: new mongoose.Types.ObjectId(req.params.projectId) };

  if (req.query.instrumentId) {
    if (mongoose.Types.ObjectId.isValid(req.query.instrumentId)) {
      base.instrumentId = new mongoose.Types.ObjectId(String(req.query.instrumentId));
    } else {
      const { Instrument } = await import('../models/index.js');
      const inst = await Instrument.findOne({ projectId: req.params.projectId, code: req.query.instrumentId }).lean();
      if (inst) base.instrumentId = inst._id;
    }
  }

  if (req.query.channelId && mongoose.Types.ObjectId.isValid(req.query.channelId)) {
    base.channelId = new mongoose.Types.ObjectId(String(req.query.channelId));
  }
  if (req.query.parameter) {
    base.parameterCode = { $in: String(req.query.parameter).split(',') };
  }
  if (req.query.quality) {
    base.quality = { $in: String(req.query.quality).split(',') };
  }
  if (req.query.source) {
    base['metadata.source'] = req.query.source;
  }

  if (mode === 'raw') {
    base.sampleTime = { ...timeQuery };
    if (cursor?.t) base.sampleTime.$lt = new Date(cursor.t);
    const rawQuery = RawReading.find(base)
      .sort({ sampleTime: -1, _id: -1 })
      .populate('instrumentId', 'code name typeName status')
      .populate('channelId', 'code label parameterCode engineeringUnit rawUnit');

    if (page) {
      const skip = (page - 1) * limit;
      const [total, rows] = await Promise.all([
        RawReading.countDocuments(base),
        rawQuery.skip(skip).limit(limit).lean()
      ]);
      return res.json({
        items: rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      });
    }

    const rows = await rawQuery.limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const pageItems = rows.slice(0, limit);
    return res.json({
      items: pageItems,
      nextCursor: hasMore ? encodeCursor({ observedAt: pageItems.at(-1).sampleTime, _id: pageItems.at(-1)._id }) : null
    });
  }

  base.observedAt = { ...timeQuery };
  if (cursor?.t) base.observedAt.$lt = new Date(cursor.t);

  const derivedQuery = DerivedReading.find(base)
    .sort({ observedAt: -1, _id: -1 })
    .populate('instrumentId', 'code name typeName status')
    .populate('channelId', 'code label parameterCode engineeringUnit rawUnit')
    .populate('rawReadingId', 'rawValue rawUnit quality sourceMetadata sampleTime');

  if (page) {
    const skip = (page - 1) * limit;
    const [total, rows] = await Promise.all([
      DerivedReading.countDocuments(base),
      derivedQuery.skip(skip).limit(limit).lean()
    ]);
    const items = rows.map(formatHistoryRow);
    return res.json({
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  }

  const rows = await derivedQuery.limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const pageItems = rows.slice(0, limit);
  res.json({
    items: pageItems.map(formatHistoryRow),
    nextCursor: hasMore && pageItems.length ? encodeCursor(pageItems.at(-1)) : null
  });
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
  const { from, to } = resolveTelemetryTimeRange(req.query);
  const timeQuery = from ? { $gte: from, $lte: to } : { $lte: to };

  const q = { projectId: new mongoose.Types.ObjectId(req.params.projectId), observedAt: timeQuery };
  if (req.query.instrumentId) {
    if (mongoose.Types.ObjectId.isValid(req.query.instrumentId)) {
      q.instrumentId = new mongoose.Types.ObjectId(String(req.query.instrumentId));
    } else {
      const { Instrument } = await import('../models/index.js');
      const inst = await Instrument.findOne({ projectId: req.params.projectId, code: req.query.instrumentId }).lean();
      if (inst) q.instrumentId = inst._id;
    }
  }
  if (req.query.parameter) q.parameterCode = { $in: String(req.query.parameter).split(',') };
  if (req.query.channelId && mongoose.Types.ObjectId.isValid(req.query.channelId)) {
    q.channelId = new mongoose.Types.ObjectId(String(req.query.channelId));
  }
  if (req.query.quality) q.quality = { $in: String(req.query.quality).split(',') };
  if (req.query.source) q['metadata.source'] = req.query.source;

  const { Project } = await import('../models/index.js');
  const project = await Project.findById(req.params.projectId).lean();
  const projectCode = project?.code || req.params.projectId;
  const dateStr = new Date().toISOString().split('T')[0];

  const rows = await DerivedReading.find(q)
    .sort({ observedAt: -1 })
    .limit(10000)
    .populate('instrumentId', 'code name typeName')
    .populate('channelId', 'code label parameterCode engineeringUnit rawUnit')
    .populate('rawReadingId', 'rawValue rawUnit quality sourceMetadata')
    .lean();

  const esc = (v) => `"${String(v ?? '').replaceAll('"','""')}"`;
  const lines = ['Timestamp,Instrument Code,Instrument Name,Channel,Raw Value,Engineering Value,Delta From Baseline,Unit,Quality,Source'];
  for (const r of rows) {
    const formatted = formatHistoryRow(r);
    const ts = formatted.observedAt ? new Date(formatted.observedAt).toISOString() : '';
    const instCode = formatted.instrumentCode;
    const instName = formatted.instrumentName;
    const chLabel = formatted.channelLabel;
    const rawVal = formatted.rawValue !== null ? formatted.rawValue : '—';
    const engVal = formatted.engineeringValue !== null ? Number(formatted.engineeringValue).toFixed(3) : '';
    const delta = formatted.deltaFromBaseline !== null ? Number(formatted.deltaFromBaseline).toFixed(3) : '—';
    const unit = formatted.unit;
    const quality = formatted.quality;
    const source = formatted.source;
    lines.push([ts, instCode, instName, chLabel, rawVal, engVal, delta, unit, quality, source].map(esc).join(','));
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${projectCode}-historical-data-${dateStr}.csv"`);
  res.send(lines.join('\n'));
}));

router.get('/projects/:projectId/latest-state', requireAuth, requireProjectAccess, asyncHandler(async (req, res) => res.json(await LatestState.find({ projectId: req.params.projectId }).sort({ observedAt: -1 }).lean())));
export default router;
