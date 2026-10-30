import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import {
  Alarm,
  AlarmEvent,
  Device,
  DeviceGatewayMapping,
  DerivedReading,
  EngineeringSeverityRule,
  Instrument,
  InstrumentCatalog,
  Investigation,
  InvestigationEvent,
  InvestigationNote,
  LatestState,
  Project,
  ProjectGateway,
  RawReading,
  Report,
  Sensor,
  SensorChannel,
  SensorDeviceMapping,
  Site,
  Zone
} from '../models/index.js';
import { getProjectOperationalSummaries } from './instrument-summary.service.js';
import { getProjectOverview } from './overview.service.js';
import { ApiError } from '../utils/api-error.js';

const reportsDir = path.resolve('uploads/reports');
fs.mkdirSync(reportsDir, { recursive: true });

// =========================================================================
// DATE RANGE RESOLUTION & VALIDATION
// =========================================================================

/**
 * Resolves and validates report time range.
 * Supports: from, to, period ('all', '24h', '7d', '30d', '90d').
 * Validates from <= to.
 * Safe default: 30 days window when neither from nor period is provided.
 */
export function resolveReportTimeRange(query = {}) {
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
    // Default safe window: last 30 days
    from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  if (from && from > to) {
    throw new ApiError(400, 'Invalid bounded time range: from > to');
  }

  return { from, to };
}

/**
 * Builds standard report metadata envelope.
 */
function buildReportMetadata({ reportType, project, from, to, user, filters = {} }) {
  return {
    reportType,
    project: {
      id: project._id,
      name: project.name,
      code: project.code,
      location: project.location || null,
      timezone: project.timezone || 'UTC'
    },
    period: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null
    },
    generatedAt: new Date().toISOString(),
    generatedBy: user?.displayName || user?.email || (user?.userId && !/^[0-9a-f]{24}$/i.test(user?.userId) ? user.userId : null) || 'System User',
    user: user ? {
      displayName: user.displayName || null,
      email: user.email || null,
      role: user.role || null
    } : null,
    filters
  };
}

// =========================================================================
// 1. PROJECT MONITORING SUMMARY REPORT
// =========================================================================

export async function getProjectMonitoringReport({
  projectId,
  organizationId = null,
  from: rawFrom,
  to: rawTo,
  period,
  user = null
}) {
  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const { from, to } = resolveReportTimeRange({ from: rawFrom, to: rawTo, period });
  const timeQuery = from ? { $gte: from, $lte: to } : { $lte: to };

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  // Fetch site names
  const sites = await Site.find({ projectId: project._id, ...orgFilter }).lean();
  const siteNames = sites.map(s => s.name).join(', ') || project.location || '—';

  // O(1) bulk fetch operational summaries for instruments
  const [
    summaries,
    rawInstruments,
    rawDevices,
    rawGateways,
    canonicalAlarms,
    investigations
  ] = await Promise.all([
    getProjectOperationalSummaries(project._id, effectiveOrgId),
    Instrument.find({ projectId: project._id, ...orgFilter, status: { $ne: 'DELETED' } }).lean(),
    Device.find({ projectId: project._id, ...orgFilter, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    ProjectGateway.find({ projectId: project._id, ...orgFilter, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    Alarm.find({ projectId: project._id, ...orgFilter, lifecycleVersion: 2, triggeredAt: timeQuery }).lean(),
    Investigation.find({ projectId: project._id, ...orgFilter, lifecycleVersion: 1, createdAt: timeQuery }).lean()
  ]);

  // Instrument coverage
  const total = rawInstruments.length;
  const commissioned = rawInstruments.filter(i => i.status === 'COMMISSIONED' || i.commissioningStatus === 'COMMISSIONED').length;

  let positioned = 0;
  let unpositioned = 0;
  let reporting = 0;
  let noTelemetry = 0;

  const severitySummary = {
    S0: 0,
    S1: 0,
    S2: 0,
    S3: 0,
    S4: 0,
    NOT_EVALUATED: 0
  };

  const qualitySummary = {
    valid: 0,
    suspect: 0,
    invalid: 0,
    unavailable: 0
  };

  for (const s of summaries) {
    const isPositioned = s.location?.longitude !== null &&
      s.location?.latitude !== null &&
      Number.isFinite(s.location?.longitude) &&
      Number.isFinite(s.location?.latitude) &&
      !(s.location.longitude === 0 && s.location.latitude === 0);

    if (isPositioned) positioned++;
    else unpositioned++;

    const hasTelemetry = s.latest?.engineeringValue !== null ||
      s.latest?.rawValue !== null ||
      Boolean(s.latest?.timestamp);

    if (hasTelemetry) reporting++;
    else noTelemetry++;

    const sev = (s.operational?.severity || '').toUpperCase().replace(/\s+/g, '_');
    if (sev === 'S0') severitySummary.S0++;
    else if (sev === 'S1') severitySummary.S1++;
    else if (sev === 'S2') severitySummary.S2++;
    else if (sev === 'S3') severitySummary.S3++;
    else if (sev === 'S4') severitySummary.S4++;
    else severitySummary.NOT_EVALUATED++;

    const q = (s.operational?.quality || '').toUpperCase();
    if (q === 'VALID') qualitySummary.valid++;
    else if (q === 'SUSPECT') qualitySummary.suspect++;
    else if (q === 'INVALID') qualitySummary.invalid++;
    else qualitySummary.unavailable++;
  }

  // Device & Gateway runtime status evaluation
  const now = Date.now();
  let devOnline = 0;
  let devOffline = 0;
  for (const d of rawDevices) {
    let isOnline = false;
    if (d.lastSeenAt) {
      const ageMs = now - new Date(d.lastSeenAt).getTime();
      const intervalMs = Math.max(60, d.expectedIntervalSec || 900) * 1000;
      isOnline = ageMs <= intervalMs * 2;
    } else if (d.runtimeStatus) {
      isOnline = d.runtimeStatus.toUpperCase() === 'ONLINE';
    }
    if (isOnline) devOnline++;
    else devOffline++;
  }

  let gwOnline = 0;
  let gwOffline = 0;
  for (const g of rawGateways) {
    const lastSeenAt = g.metadata?.lastSeenAt || null;
    let isOnline = false;
    if (lastSeenAt) {
      const ageMs = now - new Date(lastSeenAt).getTime();
      const intervalMs = 1800 * 1000;
      isOnline = ageMs <= intervalMs * 2;
    } else if (g.runtimeStatus) {
      isOnline = g.runtimeStatus.toUpperCase() === 'ONLINE';
    }
    if (isOnline) gwOnline++;
    else gwOffline++;
  }

  // Canonical Alarms within selected date range
  const alarmCounts = {
    total: canonicalAlarms.length,
    open: canonicalAlarms.filter(a => a.status === 'OPEN').length,
    acknowledged: canonicalAlarms.filter(a => a.status === 'ACKNOWLEDGED').length,
    resolved: canonicalAlarms.filter(a => a.status === 'RESOLVED').length,
    severityDistribution: {
      S0: canonicalAlarms.filter(a => (a.highestSeverity || a.currentSeverity) === 'S0').length,
      S1: canonicalAlarms.filter(a => (a.highestSeverity || a.currentSeverity) === 'S1').length,
      S2: canonicalAlarms.filter(a => (a.highestSeverity || a.currentSeverity) === 'S2').length,
      S3: canonicalAlarms.filter(a => (a.highestSeverity || a.currentSeverity) === 'S3').length,
      S4: canonicalAlarms.filter(a => (a.highestSeverity || a.currentSeverity) === 'S4').length
    }
  };

  // Investigations within selected date range
  const investigationCounts = {
    total: investigations.length,
    open: investigations.filter(i => i.status === 'OPEN').length,
    inProgress: investigations.filter(i => i.status === 'IN_PROGRESS').length,
    completed: investigations.filter(i => i.status === 'COMPLETED').length
  };

  const meta = buildReportMetadata({
    reportType: 'PROJECT_MONITORING_SUMMARY',
    project,
    from,
    to,
    user,
    filters: { from: from ? from.toISOString() : null, to: to.toISOString(), period: period || null }
  });

  return {
    ...meta,
    data: {
      project: {
        name: project.name,
        code: project.code,
        site: siteNames,
        reportPeriod: { from: from ? from.toISOString() : null, to: to.toISOString() },
        generatedAt: meta.generatedAt
      },
      instrumentCoverage: {
        total,
        commissioned,
        positioned,
        unpositioned,
        reporting,
        noTelemetry
      },
      severitySummary,
      severityDistribution: severitySummary,
      qualitySummary,
      measurementQuality: qualitySummary,
      infrastructure: {
        devices: {
          total: rawDevices.length,
          online: devOnline,
          offline: devOffline
        },
        gateways: {
          total: rawGateways.length,
          online: gwOnline,
          offline: gwOffline
        }
      },
      alarms: alarmCounts,
      alarmSummary: alarmCounts,
      investigations: investigationCounts,
      investigationSummary: investigationCounts
    }
  };
}

// =========================================================================
// 2. INSTRUMENT TREND REPORT
// =========================================================================

export async function getInstrumentTrendReport({
  projectId,
  organizationId = null,
  instrumentId,
  parameterCode: reqParamCode,
  channel: reqChannel,
  from: rawFrom,
  to: rawTo,
  period,
  aggregation = 'raw',
  user = null
}) {
  if (!instrumentId) throw new ApiError(400, 'instrumentId is required');

  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  const instQuery = { projectId: project._id, ...orgFilter };
  if (mongoose.Types.ObjectId.isValid(instrumentId)) {
    instQuery._id = instrumentId;
  } else {
    instQuery.code = instrumentId;
  }
  const instrument = await Instrument.findOne(instQuery).lean();
  if (!instrument) throw new ApiError(404, 'Instrument not found');

  const { from, to } = resolveReportTimeRange({ from: rawFrom, to: rawTo, period });
  const timeQuery = from ? { $gte: from, $lte: to } : { $lte: to };

  // Fetch channels for this instrument
  const channels = await SensorChannel.find({ instrumentId: instrument._id, projectId: project._id, ...orgFilter }).lean();

  // Resolve target channel and parameterCode
  let targetChannel = null;
  const paramFilter = reqParamCode || reqChannel;

  if (paramFilter) {
    targetChannel = channels.find(c => c.parameterCode === paramFilter || c.code === paramFilter) || null;
  }
  if (!targetChannel) {
    // Default display channel: prefer displacement for inclinometer, pressure for piezometer, or first
    targetChannel = channels.find(c => c.parameterCode === 'x_displacement' || c.code === 'x_displacement') ||
      channels.find(c => c.parameterCode === 'pore_pressure' || c.code === 'pore_pressure') ||
      channels.find(c => !c.parameterCode?.includes('temp')) ||
      channels[0] || null;
  }

  const effectiveParamCode = targetChannel?.parameterCode || paramFilter || 'x_displacement';
  const unit = targetChannel?.engineeringUnit || targetChannel?.rawUnit || '';

  // Catalogue & location context
  const [siteDoc, zoneDoc, catalogueDoc] = await Promise.all([
    instrument.siteId ? Site.findOne({ _id: instrument.siteId, ...orgFilter }).lean() : null,
    instrument.zoneId ? Zone.findOne({ _id: instrument.zoneId, ...orgFilter }).lean() : null,
    instrument.sensor_uid || instrument.catalogCode ? Sensor.findOne({
      $or: [{ uid: instrument.sensor_uid }, { uid: instrument.catalogCode }]
    }).lean() : null
  ]);

  const siteName = siteDoc?.name || '—';
  const zoneName = zoneDoc?.name || '—';
  const modelName = catalogueDoc?.model || instrument.metadata?.model || '—';
  const typeName = catalogueDoc?.name || instrument.name || 'Unknown Type';

  const baselineConfigured = targetChannel?.baseline?.configured === true;
  const baselineValue = baselineConfigured ? Number(targetChannel.baseline.value ?? 0) : null;

  const calibrationConfigured = targetChannel?.calibration?.configured === true;
  const calibrationMetadata = {
    configured: calibrationConfigured,
    scale: targetChannel?.calibration?.scale ?? 1,
    offset: targetChannel?.calibration?.offset ?? 0,
    version: targetChannel?.calibration?.version || 1,
    source: targetChannel?.calibration?.source || (calibrationConfigured ? 'DEVICE_NATIVE' : '—')
  };

  const match = {
    projectId: project._id,
    ...orgFilter,
    instrumentId: instrument._id,
    parameterCode: effectiveParamCode,
    observedAt: timeQuery
  };

  let timeSeries = [];

  // Aggregation handling: raw vs hourly / daily buckets
  const bucket = String(aggregation || 'raw').toLowerCase();

  if (bucket === 'raw' || bucket === 'none') {
    const readings = await DerivedReading.find(match)
      .sort({ observedAt: 1 })
      .limit(10000)
      .populate('rawReadingId', 'rawValue rawUnit quality')
      .lean();

    timeSeries = readings.map(r => ({
      timestamp: r.observedAt,
      value: r.value,
      engineeringValue: r.value,
      rawValue: r.rawReadingId?.rawValue !== undefined && r.rawReadingId?.rawValue !== null ? r.rawReadingId.rawValue : null,
      rawUnit: r.rawReadingId?.rawUnit || '',
      deltaFromBaseline: r.deltaFromBaseline !== undefined && r.deltaFromBaseline !== null ? r.deltaFromBaseline : null,
      quality: r.quality || 'VALID',
      severity: r.severity?.evaluated ? r.severity.level : (r.severity?.level || 'NOT_EVALUATED')
    }));
  } else {
    const units = {
      '5m': { unit: 'minute', binSize: 5 },
      '15m': { unit: 'minute', binSize: 15 },
      '1h': { unit: 'hour', binSize: 1 },
      'hour': { unit: 'hour', binSize: 1 },
      '1d': { unit: 'day', binSize: 1 },
      'day': { unit: 'day', binSize: 1 }
    };
    const b = units[bucket] || units['1h'];

    const aggData = await DerivedReading.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            bucket: { $dateTrunc: { date: '$observedAt', unit: b.unit, binSize: b.binSize } }
          },
          avg: { $avg: '$value' },
          min: { $min: '$value' },
          max: { $max: '$value' },
          count: { $sum: 1 },
          lastQuality: { $last: '$quality' },
          lastSeverity: { $last: '$severity.level' }
        }
      },
      { $sort: { '_id.bucket': 1 } }
    ]);

    timeSeries = aggData.map(d => ({
      timestamp: d._id.bucket,
      value: Number(d.avg.toFixed(4)),
      engineeringValue: Number(d.avg.toFixed(4)),
      min: Number(d.min.toFixed(4)),
      max: Number(d.max.toFixed(4)),
      count: d.count,
      rawValue: null,
      deltaFromBaseline: baselineConfigured ? Number((d.avg - baselineValue).toFixed(4)) : null,
      quality: d.lastQuality || 'VALID',
      severity: d.lastSeverity || 'NOT_EVALUATED'
    }));
  }

  // Summary statistics: Only valid numeric values
  const numericValues = timeSeries.map(r => r.value).filter(v => typeof v === 'number' && Number.isFinite(v));
  let summary = {
    firstValue: null,
    lastValue: null,
    min: null,
    max: null,
    avg: null,
    minimum: null,
    maximum: null,
    average: null,
    change: null,
    sampleCount: numericValues.length
  };

  if (numericValues.length > 0) {
    const firstVal = numericValues[0];
    const lastVal = numericValues[numericValues.length - 1];
    const minVal = Math.min(...numericValues);
    const maxVal = Math.max(...numericValues);
    const sumVal = numericValues.reduce((acc, curr) => acc + curr, 0);
    const avgVal = sumVal / numericValues.length;

    summary = {
      firstValue: Number(firstVal.toFixed(4)),
      lastValue: Number(lastVal.toFixed(4)),
      min: Number(minVal.toFixed(4)),
      max: Number(maxVal.toFixed(4)),
      avg: Number(avgVal.toFixed(4)),
      minimum: Number(minVal.toFixed(4)),
      maximum: Number(maxVal.toFixed(4)),
      average: Number(avgVal.toFixed(4)),
      change: Number((lastVal - firstVal).toFixed(4)),
      sampleCount: numericValues.length
    };
  }

  const meta = buildReportMetadata({
    reportType: 'INSTRUMENT_TREND_REPORT',
    project,
    from,
    to,
    user,
    filters: {
      instrumentId: instrument.code,
      parameterCode: effectiveParamCode,
      aggregation: bucket,
      from: from ? from.toISOString() : null,
      to: to.toISOString()
    }
  });

  return {
    ...meta,
    data: {
      instrument: {
        id: instrument._id,
        code: instrument.code,
        name: instrument.name,
        catalogCode: instrument.catalogCode,
        model: modelName,
        typeName,
        site: siteName,
        zone: zoneName,
        coordinates: Array.isArray(instrument.coordinates) ? instrument.coordinates : null,
        depthM: Number.isFinite(instrument.depthM) ? instrument.depthM : null,
        orientationDeg: Number.isFinite(instrument.orientationDeg) ? instrument.orientationDeg : null
      },
      parameter: {
        code: effectiveParamCode,
        name: targetChannel?.label || effectiveParamCode,
        unit,
        baselineValue,
        baselineConfigured
      },
      measurementContext: {
        parameter: effectiveParamCode,
        label: targetChannel?.label || effectiveParamCode,
        unit,
        baseline: {
          configured: baselineConfigured,
          value: baselineValue
        },
        calibration: calibrationMetadata
      },
      aggregation: bucket,
      readings: timeSeries,
      timeSeries,
      summary
    }
  };
}

// =========================================================================
// 3. ALARM HISTORY REPORT
// =========================================================================

export async function getAlarmHistoryReport({
  projectId,
  organizationId = null,
  from: rawFrom,
  to: rawTo,
  period,
  status,
  category,
  instrumentId,
  severity,
  detailed = false,
  page = 1,
  limit = 50,
  isExport = false,
  user = null
}) {
  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  const { from, to } = resolveReportTimeRange({ from: rawFrom, to: rawTo, period });
  const timeQuery = from ? { $gte: from, $lte: to } : { $lte: to };

  // Explicit canonical lifecycleVersion 2 only!
  const query = {
    projectId: project._id,
    ...orgFilter,
    lifecycleVersion: 2,
    triggeredAt: timeQuery
  };

  if (status) {
    const statuses = String(status).split(',').map(s => s.trim().toUpperCase());
    query.status = { $in: statuses };
  }

  if (category) {
    query.category = String(category).trim().toUpperCase();
  }

  if (instrumentId) {
    if (mongoose.Types.ObjectId.isValid(instrumentId)) {
      query.instrumentId = instrumentId;
    } else {
      const inst = await Instrument.findOne({ projectId: project._id, ...orgFilter, code: instrumentId }).lean();
      if (inst) query.instrumentId = inst._id;
      else query.instrumentId = new mongoose.Types.ObjectId(); // force empty result if unknown
    }
  }

  if (severity) {
    const sev = String(severity).trim().toUpperCase();
    query.$or = [{ currentSeverity: sev }, { highestSeverity: sev }];
  }

  const parsedPage = Math.max(1, Number(page) || 1);
  const maxLimit = isExport ? 5000 : 200;
  const parsedLimit = Math.min(maxLimit, Math.max(1, Number(limit) || 50));
  const skip = (parsedPage - 1) * parsedLimit;

  const [total, openCount, ackCount, resCount, alarms] = await Promise.all([
    Alarm.countDocuments(query),
    Alarm.countDocuments({ ...query, status: 'OPEN' }),
    Alarm.countDocuments({ ...query, status: 'ACKNOWLEDGED' }),
    Alarm.countDocuments({ ...query, status: 'RESOLVED' }),
    Alarm.find(query)
      .sort({ triggeredAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .populate('instrumentId', 'code name catalogCode')
      .populate('deviceId', 'deviceId name')
      .populate('gatewayId', 'gatewayId name')
      .populate('acknowledgedBy', 'displayName email')
      .populate('resolvedBy', 'displayName email')
      .lean()
  ]);

  const alarmSummary = {
    total,
    open: openCount,
    acknowledged: ackCount,
    resolved: resCount
  };

  // If detailed report requested, fetch chronological AlarmEvents (CREATED, ESCALATED, ACKNOWLEDGED, RESOLVED)
  let eventsByAlarmId = new Map();
  if (detailed && alarms.length > 0) {
    const alarmIds = alarms.map(a => a._id);
    const events = await AlarmEvent.find({ alarmId: { $in: alarmIds }, projectId: project._id })
      .sort({ createdAt: 1 })
      .populate('actorId', 'displayName email')
      .lean();

    for (const evt of events) {
      const k = String(evt.alarmId);
      if (!eventsByAlarmId.has(k)) eventsByAlarmId.set(k, []);
      eventsByAlarmId.get(k).push({
        id: evt._id,
        eventType: evt.eventType,
        previousStatus: evt.previousStatus,
        newStatus: evt.newStatus,
        actorType: evt.actorType,
        actor: evt.actorDisplayName || evt.actorEmail || evt.actorId?.displayName || 'System',
        comment: evt.comment,
        timestamp: evt.createdAt,
        metadata: evt.metadata
      });
    }
  }

  const formattedAlarms = alarms.map(a => ({
    id: a._id,
    code: a._id.toString(),
    alarmCode: a._id.toString(),
    title: a.title,
    category: a.category,
    status: a.status,
    instrument: a.instrumentId ? {
      id: a.instrumentId._id,
      code: a.instrumentId.code,
      name: a.instrumentId.name
    } : null,
    linkedAsset: {
      instrument: a.instrumentId ? {
        id: a.instrumentId._id,
        code: a.instrumentId.code,
        name: a.instrumentId.name
      } : null,
      device: a.deviceId ? {
        id: a.deviceId._id,
        code: a.deviceId.deviceId,
        name: a.deviceId.name
      } : null,
      gateway: a.gatewayId ? {
        id: a.gatewayId._id,
        code: a.gatewayId.gatewayId,
        name: a.gatewayId.name
      } : null
    },
    parameter: a.parameterCode || null,
    parameterCode: a.parameterCode || null,
    initialSeverity: a.initialSeverity || null,
    currentSeverity: a.currentSeverity || null,
    highestSeverity: a.highestSeverity || a.currentSeverity || null,
    triggeredAt: a.triggeredAt || a.createdAt,
    acknowledgedAt: a.acknowledgedAt || null,
    acknowledgedBy: a.acknowledgedBy ? {
      id: a.acknowledgedBy._id,
      displayName: a.acknowledgedBy.displayName,
      email: a.acknowledgedBy.email
    } : null,
    resolvedAt: a.resolvedAt || null,
    resolvedBy: a.resolvedBy ? {
      id: a.resolvedBy._id,
      displayName: a.resolvedBy.displayName,
      email: a.resolvedBy.email
    } : null,
    resolutionReason: a.resolutionReason || null,
    policy: a.alarmPolicyId ? {
      id: a.alarmPolicyId,
      name: 'Default Severity Policy',
      version: a.alarmPolicyVersion || 1
    } : null,
    alarmPolicy: a.alarmPolicyId ? {
      id: a.alarmPolicyId,
      version: a.alarmPolicyVersion || 1
    } : null,
    summary: a.summary || null,
    reason: a.reason || null,
    auditTrail: detailed ? (eventsByAlarmId.get(String(a._id)) || []) : undefined,
    timeline: detailed ? (eventsByAlarmId.get(String(a._id)) || []) : undefined
  }));

  const meta = buildReportMetadata({
    reportType: 'ALARM_HISTORY_REPORT',
    project,
    from,
    to,
    user,
    filters: {
      from: from ? from.toISOString() : null,
      to: to.toISOString(),
      status: status || null,
      category: category || null,
      severity: severity || null,
      instrumentId: instrumentId || null,
      detailed: Boolean(detailed)
    }
  });

  return {
    ...meta,
    data: {
      summary: alarmSummary,
      alarms: formattedAlarms,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit) || 1
      }
    }
  };
}

// =========================================================================
// 4. INVESTIGATION REPORTS
// =========================================================================

/**
 * Detailed single investigation report.
 */
export async function getInvestigationReport({
  projectId,
  organizationId = null,
  investigationId,
  user = null
}) {
  if (!investigationId) throw new ApiError(400, 'investigationId is required');

  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  const query = { projectId: project._id, ...orgFilter };
  if (mongoose.Types.ObjectId.isValid(investigationId)) {
    query._id = investigationId;
  } else {
    query.investigationCode = String(investigationId).trim();
  }

  const investigation = await Investigation.findOne(query)
    .populate('instrumentId', 'code name catalogCode coordinates depthM')
    .populate('deviceId', 'deviceId name')
    .populate('gatewayId', 'gatewayId name')
    .populate('assignedTeamId', 'teamCode name status')
    .populate('assignedTo', 'displayName email status')
    .populate('createdBy', 'displayName email')
    .populate('startedBy', 'displayName email')
    .populate('completedBy', 'displayName email')
    .populate('alarmId', 'title category currentSeverity highestSeverity initialSeverity status triggeredAt parameterCode')
    .lean();

  if (!investigation) throw new ApiError(404, 'Investigation not found');

  // Chronological InvestigationEvents & InvestigationNotes
  const [events, findings] = await Promise.all([
    InvestigationEvent.find({ investigationId: investigation._id, projectId: project._id })
      .sort({ createdAt: 1 })
      .populate('actorId', 'displayName email')
      .lean(),
    InvestigationNote.find({ investigationId: investigation._id, projectId: project._id })
      .sort({ createdAt: 1 })
      .populate('createdBy', 'displayName email')
      .lean()
  ]);

  // Extract immutable alarmSnapshot
  const snap = investigation.alarmSnapshot || {};
  const linkedAlarm = investigation.alarmId || {};

  const sourceAlarm = {
    id: snap.alarmId || linkedAlarm._id || null,
    title: snap.title || linkedAlarm.title || null,
    category: snap.category || linkedAlarm.category || null,
    initialSeverity: snap.initialSeverity || linkedAlarm.initialSeverity || null,
    currentSeverity: snap.currentSeverity || linkedAlarm.currentSeverity || null,
    highestSeverity: snap.highestSeverity || linkedAlarm.highestSeverity || null,
    parameter: snap.parameterCode || linkedAlarm.parameterCode || investigation.parameterCode || null,
    triggeredAt: snap.triggeredAt || linkedAlarm.triggeredAt || null,
    status: snap.status || linkedAlarm.status || null
  };

  const asset = {
    instrument: investigation.instrumentId ? {
      id: investigation.instrumentId._id,
      code: investigation.instrumentId.code,
      name: investigation.instrumentId.name
    } : null,
    device: investigation.deviceId ? {
      id: investigation.deviceId._id,
      code: investigation.deviceId.deviceId,
      name: investigation.deviceId.name
    } : null,
    gateway: investigation.gatewayId ? {
      id: investigation.gatewayId._id,
      code: investigation.gatewayId.gatewayId,
      name: investigation.gatewayId.name
    } : null,
    parameter: investigation.parameterCode || sourceAlarm.parameter || null
  };

  const assignedTeamName = investigation.assignedTeamId?.name ||
    investigation.assignedTeamSnapshot?.teamName ||
    null;
  const assignedTeamCode = investigation.assignedTeamId?.teamCode ||
    investigation.assignedTeamSnapshot?.teamCode ||
    null;

  const assignedPersonName = investigation.assignedUserSnapshot?.displayName ||
    investigation.assignedTo?.displayName ||
    null;
  const assignedPersonCode = investigation.assignedUserSnapshot?.employeeCode || null;
  const assignedPersonDesignation = investigation.assignedUserSnapshot?.designation || null;

  const assignedTeam = assignedTeamName ? {
    id: investigation.assignedTeamId?._id || investigation.assignedTeamSnapshot?.teamId || null,
    teamCode: assignedTeamCode,
    name: assignedTeamName,
    teamName: assignedTeamName,
    status: investigation.assignedTeamId?.status || 'ACTIVE'
  } : null;

  const assignedPerson = assignedPersonName ? {
    id: investigation.assignedTo?._id || investigation.assignedUserSnapshot?.userId || null,
    displayName: assignedPersonName,
    name: assignedPersonName,
    email: investigation.assignedTo?.email || '',
    employeeCode: assignedPersonCode,
    designation: assignedPersonDesignation,
    status: investigation.assignedTo?.status || 'ACTIVE'
  } : null;

  const assignment = {
    assignedTeam,
    assignedPerson,
    assignedTo: assignedPerson,
    assignedAt: investigation.assignedAt || null
  };

  const findingsList = findings.map(f => ({
    id: f._id,
    type: f.type,
    text: f.text,
    body: f.text,
    evidenceReferences: f.evidenceReferences || [],
    author: f.actorDisplayName || f.createdBy?.displayName || 'Unknown',
    createdBy: {
      name: f.actorDisplayName || f.createdBy?.displayName || 'Unknown',
      email: f.createdBy?.email || ''
    },
    createdAt: f.createdAt
  }));

  const auditTimeline = events.map(e => ({
    id: e._id,
    eventType: e.eventType,
    previousStatus: e.previousStatus,
    newStatus: e.newStatus,
    comment: e.comment,
    actor: {
      name: e.actorDisplayName || e.actorEmail || e.actorId?.displayName || 'System',
      email: e.actorEmail || ''
    },
    actorName: e.actorDisplayName || e.actorEmail || e.actorId?.displayName || 'System',
    timestamp: e.createdAt,
    metadata: e.metadata
  }));

  const meta = buildReportMetadata({
    reportType: 'INVESTIGATION_REPORT',
    project,
    from: null,
    to: new Date(),
    user,
    filters: { investigationId: investigation.investigationCode || investigation._id }
  });

  return {
    ...meta,
    assignedTeam,
    assignedPerson,
    data: {
      investigation: {
        id: investigation._id,
        code: investigation.investigationCode,
        title: investigation.title,
        status: investigation.status,
        priority: investigation.priority,
        createdAt: investigation.createdAt,
        startedAt: investigation.startedAt || null,
        completedAt: investigation.completedAt || null
      },
      header: {
        investigationCode: investigation.investigationCode,
        title: investigation.title,
        status: investigation.status,
        priority: investigation.priority,
        created: {
          at: investigation.createdAt,
          by: investigation.createdBy ? {
            id: investigation.createdBy._id,
            displayName: investigation.createdBy.displayName,
            email: investigation.createdBy.email
          } : null
        },
        started: {
          at: investigation.startedAt || null,
          by: investigation.startedBy ? {
            id: investigation.startedBy._id,
            displayName: investigation.startedBy.displayName,
            email: investigation.startedBy.email
          } : null
        },
        completed: {
          at: investigation.completedAt || null,
          by: investigation.completedBy ? {
            id: investigation.completedBy._id,
            displayName: investigation.completedBy.displayName,
            email: investigation.completedBy.email
          } : null
        }
      },
      sourceAlarm,
      asset,
      assignment: {
        assignedTeam,
        assignedTo: assignedPerson,
        assignedPerson,
        assignedAt: investigation.assignedAt || null
      },
      description: investigation.description || '',
      findings: findingsList,
      finalOutcome: {
        conclusion: investigation.conclusion || null,
        rootCause: investigation.rootCause || null,
        recommendedAction: investigation.recommendedAction || null
      },
      audit: auditTimeline
    }
  };
}

/**
 * Project / date-range Investigation summary list report with pagination.
 */
export async function getInvestigationSummaryReport({
  projectId,
  organizationId = null,
  from: rawFrom,
  to: rawTo,
  period,
  status,
  priority,
  instrumentId,
  page = 1,
  limit = 50,
  isExport = false,
  user = null
}) {
  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  const { from, to } = resolveReportTimeRange({ from: rawFrom, to: rawTo, period });
  const timeQuery = from ? { $gte: from, $lte: to } : { $lte: to };

  const query = {
    projectId: project._id,
    ...orgFilter,
    lifecycleVersion: 1,
    createdAt: timeQuery
  };

  if (status) query.status = String(status).trim().toUpperCase();
  if (priority) query.priority = String(priority).trim().toUpperCase();

  if (instrumentId) {
    if (mongoose.Types.ObjectId.isValid(instrumentId)) {
      query.instrumentId = instrumentId;
    } else {
      const inst = await Instrument.findOne({ projectId: project._id, ...orgFilter, code: instrumentId }).lean();
      if (inst) query.instrumentId = inst._id;
      else query.instrumentId = new mongoose.Types.ObjectId();
    }
  }

  const parsedPage = Math.max(1, Number(page) || 1);
  const maxLimit = isExport ? 5000 : 200;
  const parsedLimit = Math.min(maxLimit, Math.max(1, Number(limit) || 50));
  const skip = (parsedPage - 1) * parsedLimit;

  const [total, openCount, inProgCount, compCount, items] = await Promise.all([
    Investigation.countDocuments(query),
    Investigation.countDocuments({ ...query, status: 'OPEN' }),
    Investigation.countDocuments({ ...query, status: 'IN_PROGRESS' }),
    Investigation.countDocuments({ ...query, status: 'COMPLETED' }),
    Investigation.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .populate('instrumentId', 'code name')
      .populate('assignedTeamId', 'teamCode name status')
      .populate('assignedTo', 'displayName email status')
      .populate('alarmId', 'title currentSeverity highestSeverity status')
      .lean()
  ]);

  const investigationSummary = {
    total,
    open: openCount,
    inProgress: inProgCount,
    completed: compCount
  };

  const formatted = items.map(inv => {
    const teamName = inv.assignedTeamId?.name || inv.assignedTeamSnapshot?.teamName || null;
    const teamCode = inv.assignedTeamId?.teamCode || inv.assignedTeamSnapshot?.teamCode || null;
    const personName = inv.assignedUserSnapshot?.displayName || inv.assignedTo?.displayName || null;

    return {
      id: inv._id,
      code: inv.investigationCode,
      investigationCode: inv.investigationCode,
      title: inv.title,
      status: inv.status,
      priority: inv.priority,
      category: inv.category || 'ENGINEERING_SEVERITY',
      parameter: inv.parameterCode || null,
      sourceAlarm: inv.alarmId ? {
        id: inv.alarmId._id,
        code: inv.alarmId.code || inv.alarmId.title,
        title: inv.alarmId.title
      } : (inv.alarmSnapshot ? {
        id: inv.alarmSnapshot.alarmId || inv.alarmId,
        code: inv.alarmSnapshot.code || (inv.alarmSnapshot.alarmId ? `ALM-${String(inv.alarmSnapshot.alarmId).slice(-6).toUpperCase()}` : inv.alarmSnapshot.title),
        title: inv.alarmSnapshot.title
      } : (inv.alarmId ? { id: inv.alarmId, code: `ALM-${String(inv.alarmId).slice(-6).toUpperCase()}` } : null)),
      alarmSnapshot: inv.alarmSnapshot || null,
      linkedAlarm: inv.alarmId ? {
        id: inv.alarmId._id,
        title: inv.alarmId.title,
        currentSeverity: inv.alarmId.currentSeverity,
        status: inv.alarmId.status
      } : null,
      asset: {
        instrument: inv.instrumentId ? {
          id: inv.instrumentId._id,
          code: inv.instrumentId.code,
          name: inv.instrumentId.name
        } : null,
        parameter: inv.parameterCode || null
      },
      instrument: inv.instrumentId ? {
        id: inv.instrumentId._id,
        code: inv.instrumentId.code,
        name: inv.instrumentId.name
      } : null,
      assignedTeam: teamName ? {
        id: inv.assignedTeamId?._id || inv.assignedTeamSnapshot?.teamId || null,
        teamCode,
        name: teamName,
        teamName,
        status: inv.assignedTeamId?.status || 'ACTIVE'
      } : null,
      assignedTeamSnapshot: inv.assignedTeamSnapshot || null,
      assignedUserSnapshot: inv.assignedUserSnapshot || null,
      assignedTo: personName ? {
        id: inv.assignedTo?._id || inv.assignedUserSnapshot?.userId || null,
        name: personName,
        displayName: personName,
        email: inv.assignedTo?.email || '',
        employeeCode: inv.assignedUserSnapshot?.employeeCode || null,
        designation: inv.assignedUserSnapshot?.designation || null,
        status: inv.assignedTo?.status || 'ACTIVE'
      } : null,
      finalOutcome: {
        conclusion: inv.conclusion || null
      },
      conclusion: inv.conclusion || null,
      createdAt: inv.createdAt,
      startedAt: inv.startedAt || null,
      completedAt: inv.completedAt || null
    };
  });

  const meta = buildReportMetadata({
    reportType: 'INVESTIGATION_SUMMARY_REPORT',
    project,
    from,
    to,
    user,
    filters: {
      from: from ? from.toISOString() : null,
      to: to.toISOString(),
      status: status || null,
      priority: priority || null,
      instrumentId: instrumentId || null
    }
  });

  return {
    ...meta,
    data: {
      summary: investigationSummary,
      investigations: formatted,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit) || 1
      }
    }
  };
}

// =========================================================================
// 5. INFRASTRUCTURE HEALTH REPORT
// =========================================================================

export async function getInfrastructureHealthReport({
  projectId,
  organizationId = null,
  user = null
}) {
  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  const [devices, gateways, sdms, dgms] = await Promise.all([
    Device.find({ projectId: project._id, ...orgFilter, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    ProjectGateway.find({ projectId: project._id, ...orgFilter, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    SensorDeviceMapping.find({ projectId: project._id, ...orgFilter, status: 'ACTIVE' }).lean(),
    DeviceGatewayMapping.find({ projectId: project._id, ...orgFilter, status: 'ACTIVE' }).populate('gatewayAssetId', 'gatewayId name').lean()
  ]);

  // Maps for sensor-device and device-gateway counts
  const sdmCountByDev = new Map();
  for (const s of sdms) {
    const devId = String(s.deviceAssetId);
    sdmCountByDev.set(devId, (sdmCountByDev.get(devId) || 0) + 1);
  }

  const dgmByDev = new Map();
  for (const d of dgms) {
    dgmByDev.set(String(d.deviceAssetId), d.gatewayAssetId);
  }

  const dgmCountByGw = new Map();
  for (const d of dgms) {
    const gwId = String(d.gatewayAssetId?._id || d.gatewayAssetId);
    dgmCountByGw.set(gwId, (dgmCountByGw.get(gwId) || 0) + 1);
  }

  const now = Date.now();

  const formattedDevices = devices.map(d => {
    let runtimeStatus = 'UNKNOWN';
    if (d.lastSeenAt) {
      const ageMs = now - new Date(d.lastSeenAt).getTime();
      const intervalMs = Math.max(60, d.expectedIntervalSec || 900) * 1000;
      if (ageMs <= intervalMs * 2) runtimeStatus = 'ONLINE';
      else if (ageMs <= intervalMs * 6) runtimeStatus = 'STALE';
      else runtimeStatus = 'OFFLINE';
    } else if (d.runtimeStatus) {
      runtimeStatus = d.runtimeStatus.toUpperCase();
    }

    const gwDoc = dgmByDev.get(String(d._id));

    return {
      id: d._id,
      code: d.deviceId,
      name: d.name,
      model: d.model || '—',
      commissionedStatus: d.commissioningStatus || (d.status === 'COMMISSIONED' ? 'COMMISSIONED' : 'REGISTERED'),
      commissioningStatus: d.commissioningStatus || (d.status === 'COMMISSIONED' ? 'COMMISSIONED' : 'REGISTERED'),
      runtimeConnectivity: runtimeStatus,
      mappedSensorCount: sdmCountByDev.get(String(d._id)) || 0,
      mappedSensorsCount: sdmCountByDev.get(String(d._id)) || 0,
      gatewayMapping: gwDoc ? {
        id: gwDoc._id,
        code: gwDoc.gatewayId,
        name: gwDoc.name
      } : null,
      gateway: gwDoc ? {
        id: gwDoc._id,
        code: gwDoc.gatewayId,
        name: gwDoc.name
      } : null,
      lastTelemetryAt: d.lastSeenAt || null
    };
  });

  const formattedGateways = gateways.map(g => {
    const lastSeenAt = g.metadata?.lastSeenAt || null;
    let runtimeStatus = 'UNKNOWN';
    if (lastSeenAt) {
      const ageMs = now - new Date(lastSeenAt).getTime();
      const intervalMs = 1800 * 1000;
      if (ageMs <= intervalMs * 2) runtimeStatus = 'ONLINE';
      else if (ageMs <= intervalMs * 6) runtimeStatus = 'STALE';
      else runtimeStatus = 'OFFLINE';
    } else if (g.runtimeStatus) {
      runtimeStatus = g.runtimeStatus.toUpperCase();
    } else if (g.status === 'ONLINE' || g.status === 'COMMISSIONED') {
      runtimeStatus = g.status === 'ONLINE' ? 'ONLINE' : 'UNKNOWN';
    }

    return {
      id: g._id,
      code: g.gatewayId,
      name: g.name,
      model: g.model || '—',
      commissionedStatus: g.status === 'COMMISSIONED' || g.status === 'ONLINE' ? 'COMMISSIONED' : (g.status || 'REGISTERED'),
      commissioningStatus: g.status === 'COMMISSIONED' || g.status === 'ONLINE' ? 'COMMISSIONED' : (g.status || 'REGISTERED'),
      runtimeConnectivity: runtimeStatus,
      mappedDeviceCount: dgmCountByGw.get(String(g._id)) || 0,
      mappedDevicesCount: dgmCountByGw.get(String(g._id)) || 0,
      lastSeenAt,
      lastSeen: lastSeenAt
    };
  });

  const summary = {
    devices: {
      total: devices.length,
      commissioned: formattedDevices.filter(d => d.commissionedStatus === 'COMMISSIONED').length,
      online: formattedDevices.filter(d => d.runtimeConnectivity === 'ONLINE').length,
      offline: formattedDevices.filter(d => d.runtimeConnectivity === 'OFFLINE').length
    },
    gateways: {
      total: gateways.length,
      commissioned: formattedGateways.filter(g => g.commissionedStatus === 'COMMISSIONED').length,
      online: formattedGateways.filter(g => g.runtimeConnectivity === 'ONLINE').length,
      offline: formattedGateways.filter(g => g.runtimeConnectivity === 'OFFLINE').length
    }
  };

  const meta = buildReportMetadata({
    reportType: 'INFRASTRUCTURE_HEALTH_REPORT',
    project,
    from: null,
    to: new Date(),
    user
  });

  return {
    ...meta,
    data: {
      summary,
      devices: formattedDevices,
      gateways: formattedGateways
    }
  };
}

// =========================================================================
// 6. SEVERITY / MONITORING SUMMARY REPORT
// =========================================================================

export async function getSeveritySummaryReport({
  projectId,
  organizationId = null,
  user = null
}) {
  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  // Bulk fetch operational summaries and active severity rules
  const [summaries, activeRules] = await Promise.all([
    getProjectOperationalSummaries(project._id, effectiveOrgId),
    EngineeringSeverityRule.find({ projectId: project._id, ...orgFilter, status: 'ACTIVE' }).lean()
  ]);

  const severityCounts = {
    S0: 0,
    S1: 0,
    S2: 0,
    S3: 0,
    S4: 0,
    NOT_EVALUATED: 0
  };

  const instrumentRows = summaries.map(s => {
    const inst = s.instrument;
    const isPositioned = s.location?.longitude !== null &&
      s.location?.latitude !== null &&
      Number.isFinite(s.location?.longitude) &&
      Number.isFinite(s.location?.latitude) &&
      !(s.location.longitude === 0 && s.location.latitude === 0);

    const parameterCode = s.latest?.parameterCode || s.displayChannel?.parameterCode || '—';
    const channelLabel = s.latest?.channelLabel || s.displayChannel?.label || parameterCode;

    // Resolve matching rule
    const instIdStr = String(inst._id);
    const rule = activeRules.find(r => String(r.instrumentId) === instIdStr && r.parameterCode === parameterCode) ||
      activeRules.find(r => r.catalogCode === inst.catalogCode && r.parameterCode === parameterCode && !r.instrumentId) ||
      activeRules.find(r => r.parameterCode === parameterCode && !r.instrumentId && !r.catalogCode) ||
      null;

    let currentSeverity = (s.operational?.severity || '').toUpperCase().replace(/\s+/g, '_');
    if (!['S0', 'S1', 'S2', 'S3', 'S4'].includes(currentSeverity)) {
      currentSeverity = 'NOT_EVALUATED';
    }

    // Strict rule: If no rule exists, severity = NOT_EVALUATED. Do not generate synthetic S0.
    if (!rule) {
      currentSeverity = 'NOT_EVALUATED';
    }

    if (currentSeverity === 'S0') severityCounts.S0++;
    else if (currentSeverity === 'S1') severityCounts.S1++;
    else if (currentSeverity === 'S2') severityCounts.S2++;
    else if (currentSeverity === 'S3') severityCounts.S3++;
    else if (currentSeverity === 'S4') severityCounts.S4++;
    else severityCounts.NOT_EVALUATED++;

    return {
      instrument: {
        id: inst._id,
        code: inst.code,
        name: inst.name,
        catalogCode: inst.catalogCode,
        model: inst.model,
        site: inst.siteName,
        zone: inst.zoneName,
        coordinates: isPositioned ? [s.location.longitude, s.location.latitude] : null,
        depthM: s.location.depthM,
        orientationDeg: s.location.orientationDeg,
        isPositioned
      },
      parameter: parameterCode,
      channelLabel,
      latestEngineeringValue: s.latest?.engineeringValue ?? null,
      unit: s.latest?.unit || '',
      deltaFromBaseline: s.latest?.deltaFromBaseline ?? null,
      currentSeverity,
      effectiveRule: rule ? {
        id: rule._id,
        name: rule.name,
        version: rule.version || 1,
        metric: rule.metric || 'engineeringValue'
      } : null,
      timestamp: s.latest?.timestamp || null,
      quality: s.operational?.quality || 'NOT_EVALUATED'
    };
  });

  const meta = buildReportMetadata({
    reportType: 'SEVERITY_MONITORING_SUMMARY',
    project,
    from: null,
    to: new Date(),
    user
  });

  return {
    ...meta,
    data: {
      summary: {
        totalInstruments: summaries.length,
        reportingInstruments: summaries.filter(s => s.latest?.engineeringValue !== null || s.latest?.rawValue !== null).length,
        severityDistribution: severityCounts
      },
      instruments: instrumentRows
    }
  };
}

// =========================================================================
// 7. OVERALL PROJECT MONITORING REPORT (PHASE C8C)
// =========================================================================

/**
 * Phase C8C: Overall Project Monitoring Report
 * Consolidates project monitoring, current instrument status, trend summaries,
 * engineering severity, alarm history, investigations, infrastructure health,
 * and operational attention into one unified document.
 * Coordinates existing canonical report methods without redundant recalculation.
 */
export async function getOverallProjectReport({
  projectId,
  organizationId = null,
  from: rawFrom,
  to: rawTo,
  period,
  options = {},
  user = null
}) {
  const projQuery = { _id: projectId };
  if (organizationId) projQuery.organizationId = organizationId;
  const project = await Project.findOne(projQuery).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const { from, to } = resolveReportTimeRange({ from: rawFrom, to: rawTo, period });
  const timeQuery = from ? { $gte: from, $lte: to } : { $lte: to };

  const includeTrendCharts = options.includeTrendCharts !== false && options.includeTrendCharts !== 'false' && options.includeTrendCharts !== '0';
  const includeAlarmDetails = options.includeAlarmDetails !== false && options.includeAlarmDetails !== 'false' && options.includeAlarmDetails !== '0';
  const includeInvestigationDetails = options.includeInvestigationDetails !== false && options.includeInvestigationDetails !== 'false' && options.includeInvestigationDetails !== '0';

  const effectiveOrgId = organizationId || project.organizationId;
  const orgFilter = { organizationId: effectiveOrgId };

  // 1. Compose existing canonical services in parallel
  const [
    monitoringReport,
    severityReport,
    alarmsReport,
    investigationReport,
    infrastructureReport,
    operationalSummaries,
    trendAggs,
    sites
  ] = await Promise.all([
    getProjectMonitoringReport({ projectId, organizationId: effectiveOrgId, from: rawFrom, to: rawTo, period, user }),
    getSeveritySummaryReport({ projectId, organizationId: effectiveOrgId, user }),
    getAlarmHistoryReport({
      projectId,
      organizationId: effectiveOrgId,
      from: rawFrom,
      to: rawTo,
      period,
      detailed: includeAlarmDetails,
      limit: 1000,
      isExport: true,
      user
    }),
    getInvestigationSummaryReport({
      projectId,
      organizationId: effectiveOrgId,
      from: rawFrom,
      to: rawTo,
      period,
      limit: 1000,
      isExport: true,
      user
    }),
    getInfrastructureHealthReport({ projectId, organizationId: effectiveOrgId, user }),
    getProjectOperationalSummaries(project._id, effectiveOrgId),
    DerivedReading.aggregate([
      {
        $match: {
          projectId: project._id,
          ...orgFilter,
          observedAt: timeQuery
        }
      },
      {
        $sort: { observedAt: 1 }
      },
      {
        $group: {
          _id: { instrumentId: '$instrumentId', parameterCode: '$parameterCode' },
          firstValue: { $first: '$value' },
          lastValue: { $last: '$value' },
          min: { $min: '$value' },
          max: { $max: '$value' },
          avg: { $avg: '$value' },
          sampleCount: { $sum: 1 }
        }
      }
    ]),
    Site.find({ projectId: project._id, ...orgFilter }).lean()
  ]);

  const siteNames = sites.map(s => s.name).join(', ') || project.location || '—';
  const nowMs = Date.now();

  // 2. Build Section 3: Current Instrument Status (Multi-channel representation)
  const currentInstruments = operationalSummaries.map(s => {
    const inst = s.instrument;
    const channels = s.channels || [];
    const channelStates = s.channelStates || {};

    const isPositioned = s.location?.longitude !== null &&
      s.location?.latitude !== null &&
      Number.isFinite(s.location?.longitude) &&
      Number.isFinite(s.location?.latitude) &&
      !(s.location.longitude === 0 && s.location.latitude === 0);

    const channelRows = channels.map(ch => {
      const state = channelStates[ch.code] || {};
      const hasTelemetry = state.value !== null && state.value !== undefined && state.observedAt;
      let freshness = 'No Telemetry';
      if (hasTelemetry) {
        const ageMs = nowMs - new Date(state.observedAt).getTime();
        const expectedIntervalMs = Math.max(60, s.connection?.device?.expectedIntervalSec || 900) * 1000;
        // Reporting if observed within 24h or 4 communication intervals
        if (ageMs <= Math.max(24 * 3600 * 1000, expectedIntervalMs * 4)) {
          freshness = 'Reporting';
        } else {
          freshness = 'Stale';
        }
      }

      let sev = state.severity || 'NOT_EVALUATED';
      if (sev === 'NOT EVALUATED') sev = 'NOT_EVALUATED';

      let qual = state.quality || 'NOT_EVALUATED';
      if (qual === 'NOT EVALUATED') qual = 'NOT_EVALUATED';

      return {
        code: ch.code,
        parameterCode: ch.parameterCode,
        label: state.label || ch.code,
        latestValue: state.value !== null && state.value !== undefined ? Number(state.value) : null,
        unit: state.unit || ch.engineeringUnit || ch.rawUnit || '',
        deltaFromBaseline: state.deltaFromBaseline !== null && state.deltaFromBaseline !== undefined ? Number(state.deltaFromBaseline) : null,
        severity: sev,
        quality: qual,
        lastObserved: state.observedAt || null,
        freshness
      };
    });

    // Instrument-level freshness is reporting if any channel is reporting
    let instFreshness = 'No Telemetry';
    if (channelRows.some(c => c.freshness === 'Reporting')) {
      instFreshness = 'Reporting';
    } else if (channelRows.some(c => c.freshness === 'Stale')) {
      instFreshness = 'Stale';
    }

    return {
      instrument: {
        id: inst._id,
        code: inst.code,
        name: inst.name,
        catalogCode: inst.catalogCode,
        model: inst.model,
        typeName: inst.typeName,
        status: inst.status,
        site: inst.siteName || siteNames,
        zone: inst.zoneName || '—',
        coordinates: isPositioned ? [s.location.longitude, s.location.latitude] : null,
        depthM: s.location.depthM,
        orientationDeg: s.location.orientationDeg,
        isPositioned,
        freshness: instFreshness
      },
      connection: {
        device: s.connection?.device ? {
          code: s.connection.device.deviceId,
          name: s.connection.device.name,
          connectivity: s.connection.device.runtimeStatus,
          lastSeenAt: s.connection.device.lastSeenAt
        } : null,
        gateway: s.connection?.gateway ? {
          code: s.connection.gateway.gatewayId,
          name: s.connection.gateway.name,
          connectivity: s.connection.gateway.runtimeStatus,
          lastSeenAt: s.connection.gateway.lastSeenAt
        } : null
      },
      channels: channelRows
    };
  });

  // 3. Build Section 4: Trend Summary
  const trendMap = new Map();
  for (const t of trendAggs) {
    const k = `${t._id.instrumentId}:${t._id.parameterCode}`;
    trendMap.set(k, t);
  }

  const trendItems = [];
  for (const s of operationalSummaries) {
    const inst = s.instrument;
    const channels = s.channels || [];
    for (const ch of channels) {
      const k = `${inst._id}:${ch.parameterCode}`;
      const agg = trendMap.get(k);
      if (agg && agg.sampleCount > 0) {
        trendItems.push({
          instrumentId: inst._id,
          instrumentCode: inst.code,
          instrumentName: inst.name,
          parameterCode: ch.parameterCode,
          parameterLabel: ch.code,
          unit: ch.engineeringUnit || ch.rawUnit || '',
          firstValue: Number(agg.firstValue.toFixed(4)),
          lastValue: Number(agg.lastValue.toFixed(4)),
          minimum: Number(agg.min.toFixed(4)),
          maximum: Number(agg.max.toFixed(4)),
          average: Number(agg.avg.toFixed(4)),
          change: Number((agg.lastValue - agg.firstValue).toFixed(4)),
          sampleCount: agg.sampleCount,
          chartPoints: []
        });
      }
    }
  }

  // If includeTrendCharts is true, fetch bounded time points for primary channels
  if (includeTrendCharts && trendItems.length > 0) {
    // Up to 8 primary trend channels for chart display
    const chartCandidates = trendItems.slice(0, 8);
    await Promise.all(chartCandidates.map(async (item) => {
      const dailyPoints = await DerivedReading.aggregate([
        {
          $match: {
            projectId: project._id,
            ...orgFilter,
            instrumentId: item.instrumentId,
            parameterCode: item.parameterCode,
            observedAt: timeQuery
          }
        },
        {
          $group: {
            _id: {
              bucket: { $dateTrunc: { date: '$observedAt', unit: 'day' } }
            },
            avg: { $avg: '$value' }
          }
        },
        { $sort: { '_id.bucket': 1 } },
        { $limit: 30 }
      ]);
      item.chartPoints = dailyPoints.map(p => ({
        timestamp: p._id.bucket,
        value: Number(p.avg.toFixed(4))
      }));
    }));
  }

  // 4. Build Section 9: Operational Attention (Composed from existing canonical states)
  // Engineering Attention
  const s4Instruments = severityReport.data.instruments.filter(i => i.currentSeverity === 'S4');
  const s3Instruments = severityReport.data.instruments.filter(i => i.currentSeverity === 'S3');
  const activeAlarms = (alarmsReport.data.alarms || []).filter(a => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED' || a.status === 'ACTIVE');

  // Monitoring Gaps
  const noTelemetryInstruments = currentInstruments.filter(ci => ci.instrument.freshness === 'No Telemetry');
  const staleInstruments = currentInstruments.filter(ci => ci.instrument.freshness === 'Stale');
  const unpositionedInstruments = severityReport.data.instruments.filter(i => !i.instrument.isPositioned);
  const noSeverityRuleInstruments = severityReport.data.instruments.filter(i => !i.effectiveRule || i.currentSeverity === 'NOT_EVALUATED');

  // Infrastructure Attention
  const rawDevs = Array.isArray(infrastructureReport.data.devices) ? infrastructureReport.data.devices : (infrastructureReport.data.devices?.items || []);
  const rawGws = Array.isArray(infrastructureReport.data.gateways) ? infrastructureReport.data.gateways : (infrastructureReport.data.gateways?.items || []);
  const offlineDevices = rawDevs.filter(d => d.runtimeConnectivity === 'OFFLINE');
  const offlineGateways = rawGws.filter(g => g.runtimeConnectivity === 'OFFLINE');

  // Workflow Attention
  const activeInvestigations = (investigationReport.data.investigations || []).filter(inv => inv.status === 'OPEN' || inv.status === 'IN_PROGRESS');

  const operationalAttention = {
    counts: {
      engineeringAttentionCount: s4Instruments.length + s3Instruments.length + activeAlarms.length,
      monitoringGapsCount: noTelemetryInstruments.length + staleInstruments.length + unpositionedInstruments.length + noSeverityRuleInstruments.length,
      infrastructureAttentionCount: offlineDevices.length + offlineGateways.length,
      workflowAttentionCount: activeInvestigations.length,
      totalAttentionItems: (
        s4Instruments.length + s3Instruments.length + activeAlarms.length +
        noTelemetryInstruments.length + staleInstruments.length + unpositionedInstruments.length + noSeverityRuleInstruments.length +
        offlineDevices.length + offlineGateways.length +
        activeInvestigations.length
      )
    },
    categories: {
      engineeringAttention: {
        title: 'Engineering Attention',
        s4Instruments: s4Instruments.map(i => ({ code: i.instrument.code, name: i.instrument.name, severity: i.currentSeverity, value: i.latestEngineeringValue, unit: i.unit })),
        s3Instruments: s3Instruments.map(i => ({ code: i.instrument.code, name: i.instrument.name, severity: i.currentSeverity, value: i.latestEngineeringValue, unit: i.unit })),
        activeAlarms: activeAlarms.map(a => ({ code: a.code || a._id, asset: a.asset?.code || a.instrumentId?.code || '—', severity: a.currentSeverity || a.highestSeverity, status: a.status }))
      },
      monitoringGaps: {
        title: 'Monitoring Gaps',
        noTelemetryInstruments: noTelemetryInstruments.map(i => ({ code: i.instrument.code, name: i.instrument.name, site: i.instrument.site })),
        staleInstruments: staleInstruments.map(i => ({ code: i.instrument.code, name: i.instrument.name, site: i.instrument.site })),
        unpositionedInstruments: unpositionedInstruments.map(i => ({ code: i.instrument.code, name: i.instrument.name })),
        noSeverityRuleInstruments: noSeverityRuleInstruments.map(i => ({ code: i.instrument.code, parameter: i.parameter, rule: 'No Rule' }))
      },
      infrastructureAttention: {
        title: 'Infrastructure Attention',
        offlineDevices: offlineDevices.map(d => ({ code: d.code, name: d.name, lastSeen: d.lastSeenAt })),
        offlineGateways: offlineGateways.map(g => ({ code: g.code, name: g.name, lastSeen: g.lastSeenAt }))
      },
      workflowAttention: {
        title: 'Workflow Attention',
        activeInvestigations: activeInvestigations.map(inv => ({ code: inv.code, asset: inv.asset?.instrument?.code || inv.instrument?.code || inv.asset?.code || '—', priority: inv.priority, status: inv.status }))
      }
    }
  };

  // 5. Build Section 10: Appendix structured detail tables
  const appendix = {
    measurementSummary: currentInstruments.map(ci => ({
      instrument: ci.instrument.code,
      name: ci.instrument.name,
      site: ci.instrument.site,
      zone: ci.instrument.zone,
      channelsCount: ci.channels.length,
      channels: ci.channels
    })),
    trendStatistics: trendItems,
    alarmHistory: alarmsReport.data.alarms || [],
    investigationList: investigationReport.data.investigations || [],
    infrastructureInventory: {
      devices: rawDevs,
      gateways: rawGws
    }
  };

  const meta = buildReportMetadata({
    reportType: 'OVERALL_PROJECT_MONITORING',
    project,
    from,
    to,
    user,
    filters: {
      period: period || (from ? 'custom' : '30d'),
      includeTrendCharts,
      includeAlarmDetails,
      includeInvestigationDetails
    }
  });

  return {
    ...meta,
    options: {
      includeTrendCharts,
      includeAlarmDetails,
      includeInvestigationDetails
    },
    data: {
      projectInformation: {
        name: project.name,
        code: project.code,
        site: siteNames,
        location: project.location || null,
        timezone: project.timezone || 'UTC',
        reportPeriod: {
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
          preset: period || (from ? 'custom' : '30d')
        },
        generatedAt: meta.generatedAt,
        generatedBy: meta.generatedBy
      },
      executiveSummary: monitoringReport.data,
      currentInstrumentStatus: {
        disclaimer: 'Latest reading available at report generation time.',
        totalInstruments: currentInstruments.length,
        instruments: currentInstruments
      },
      trendSummary: {
        period: {
          from: from ? from.toISOString() : null,
          to: to.toISOString()
        },
        totalSeries: trendItems.length,
        items: trendItems
      },
      severitySummary: severityReport.data,
      alarmSummary: {
        total: alarmsReport.data.summary?.total ?? 0,
        open: alarmsReport.data.summary?.open ?? 0,
        acknowledged: alarmsReport.data.summary?.acknowledged ?? 0,
        resolved: alarmsReport.data.summary?.resolved ?? 0,
        alarms: alarmsReport.data.alarms || []
      },
      investigationSummary: {
        total: investigationReport.data.summary?.total ?? 0,
        open: investigationReport.data.summary?.open ?? 0,
        inProgress: investigationReport.data.summary?.inProgress ?? 0,
        completed: investigationReport.data.summary?.completed ?? 0,
        investigations: investigationReport.data.investigations || []
      },
      infrastructureHealth: {
        summary: infrastructureReport.data.summary,
        devices: {
          summary: infrastructureReport.data.summary?.devices || {
            total: (infrastructureReport.data.devices || []).length,
            online: (infrastructureReport.data.devices || []).filter(d => d.runtimeConnectivity === 'ONLINE').length,
            offline: (infrastructureReport.data.devices || []).filter(d => d.runtimeConnectivity === 'OFFLINE').length
          },
          items: infrastructureReport.data.devices || []
        },
        gateways: {
          summary: infrastructureReport.data.summary?.gateways || {
            total: (infrastructureReport.data.gateways || []).length,
            online: (infrastructureReport.data.gateways || []).filter(g => g.runtimeConnectivity === 'ONLINE').length,
            offline: (infrastructureReport.data.gateways || []).filter(g => g.runtimeConnectivity === 'OFFLINE').length
          },
          items: infrastructureReport.data.gateways || []
        }
      },
      operationalAttention,
      appendix
    }
  };
}

// =========================================================================
// BACKWARD COMPATIBILITY: GENERATE PDF PROJECT SUMMARY (Pre-existing stub)
// =========================================================================

export async function generateProjectSummary(reportId) {
  const report = await Report.findById(reportId);
  if (!report) return;
  try {
    report.status = 'GENERATING'; await report.save();
    const overview = await getProjectOverview(report.projectId);
    const filename = `report-${report._id}.pdf`;
    const storagePath = path.join(reportsDir, filename);
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(storagePath);
    doc.pipe(stream);
    doc.fontSize(20).text('GeoNexa Project Summary');
    doc.moveDown().fontSize(12).text(`${overview.project.name} (${overview.project.code})`);
    doc.text(`Location: ${overview.project.location || '-'}`);
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown().fontSize(14).text('Current Status');
    doc.fontSize(11).text(`Geotechnical severity: ${overview.status.severity}`);
    doc.text(`Monitoring health: ${overview.status.monitoringHealth}`);
    doc.text(`Confidence: ${overview.status.confidence}% (${overview.status.confidenceBand})`);
    doc.text(`Primary reason: ${overview.status.primaryReason}`);
    doc.moveDown().fontSize(14).text('Assets');
    doc.fontSize(11).text(`Instruments: ${overview.counts.instruments}`);
    doc.text(`Devices: ${overview.counts.devices} (${overview.counts.onlineDevices} online)`);
    doc.text(`Open alarms: ${overview.counts.openAlarms}`);
    doc.moveDown().fontSize(14).text('Latest Measurements');
    for (const row of overview.latest.slice(0, 20)) doc.fontSize(10).text(`${row.parameterCode}: ${row.value?.toFixed?.(3) ?? row.value} ${row.unit || ''} · ${row.quality}`);
    doc.end();
    await new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); });
    report.filename = filename; report.storagePath = storagePath; report.status = 'READY'; await report.save();
  } catch (err) { report.status = 'FAILED'; report.error = err.message; await report.save(); }
}
