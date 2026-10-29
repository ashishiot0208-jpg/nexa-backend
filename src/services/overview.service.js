import { Device, Project, ProjectGateway, Alarm, DecisionSnapshot, LatestState, DerivedReading, GeospatialFeature } from '../models/index.js';
import { getProjectOperationalSummaries } from './instrument-summary.service.js';
import { maxHealth } from '../utils/severity.js';
import { deriveOperationalStatus } from './decision-status.service.js';

export async function getProjectOverview(projectId, organizationId = null) {
  const query = { _id: projectId };
  if (organizationId) query.organizationId = organizationId;
  const project = await Project.findOne(query).populate('useCaseTemplateId').lean();
  if (!project) return null;

  const orgFilter = organizationId ? { organizationId } : (project.organizationId ? { organizationId: project.organizationId } : {});

  // 1. Bulk-load all project state in parallel (O(1) queries, zero N+1)
  const [
    summaries,
    rawDevices,
    rawGateways,
    recentDecisions,
    alarms,
    latest,
    derivedHistory,
    features
  ] = await Promise.all([
    getProjectOperationalSummaries(project._id, project.organizationId),
    Device.find({ projectId: project._id, ...orgFilter, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    ProjectGateway.find({ projectId: project._id, ...orgFilter, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    DecisionSnapshot.find({ projectId: project._id, ...orgFilter }).sort({ evaluatedAt: -1 }).limit(10).lean(),
    Alarm.find({ projectId: project._id, ...orgFilter, lifecycleVersion: 2, status: { $in: ['OPEN', 'ACKNOWLEDGED'] } }).sort({ createdAt: -1 }).lean(),
    LatestState.find({ projectId: project._id, ...orgFilter }).sort({ observedAt: -1 }).limit(200).lean(),
    DerivedReading.find({ projectId: project._id, ...orgFilter }).sort({ observedAt: 1 }).limit(200).lean(),
    GeospatialFeature.find({ projectId: project._id, ...orgFilter }).lean()
  ]);

  // Asset counts & distributions
  const total = summaries.length;
  let positioned = 0;
  let unpositioned = 0;
  let noTelemetry = 0;

  const severity = {
    S0: 0,
    S1: 0,
    S2: 0,
    S3: 0,
    S4: 0,
    notEvaluated: 0
  };

  const health = {
    H0: 0,
    H1: 0,
    H2: 0,
    H3: 0,
    unknown: 0
  };

  const quality = {
    valid: 0,
    suspect: 0,
    invalid: 0,
    unavailable: 0
  };

  for (const s of summaries) {
    // Positioning check (same valid coordinate standard as C4)
    const isPositioned = s.location?.longitude !== null &&
      s.location?.latitude !== null &&
      Number.isFinite(s.location?.longitude) &&
      Number.isFinite(s.location?.latitude) &&
      !(s.location.longitude === 0 && s.location.latitude === 0);

    if (isPositioned) {
      positioned++;
    } else {
      unpositioned++;
    }

    // Telemetry check
    const hasTelemetry = s.latest?.engineeringValue !== null ||
      s.latest?.rawValue !== null ||
      Boolean(s.latest?.timestamp);

    if (!hasTelemetry) {
      noTelemetry++;
    }

    // Severity distribution
    const sev = (s.operational?.severity || '').toUpperCase();
    if (sev === 'S0') severity.S0++;
    else if (sev === 'S1') severity.S1++;
    else if (sev === 'S2') severity.S2++;
    else if (sev === 'S3') severity.S3++;
    else if (sev === 'S4') severity.S4++;
    else severity.notEvaluated++;

    // Health distribution
    const h = (s.operational?.health || '').toUpperCase();
    if (h === 'H0') health.H0++;
    else if (h === 'H1') health.H1++;
    else if (h === 'H2') health.H2++;
    else if (h === 'H3') health.H3++;
    else health.unknown++;

    // Quality distribution
    const q = (s.operational?.quality || '').toUpperCase();
    if (q === 'VALID') quality.valid++;
    else if (q === 'SUSPECT') quality.suspect++;
    else if (q === 'INVALID') quality.invalid++;
    else quality.unavailable++;
  }

  // Device runtime statuses
  const now = Date.now();
  const devices = {
    total: rawDevices.length,
    online: 0,
    offline: 0,
    stale: 0,
    unknown: 0
  };

  for (const d of rawDevices) {
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

    if (runtimeStatus === 'ONLINE') devices.online++;
    else if (runtimeStatus === 'STALE') devices.stale++;
    else if (runtimeStatus === 'OFFLINE') devices.offline++;
    else devices.unknown++;
  }

  // Gateway runtime statuses
  const gateways = {
    total: rawGateways.length,
    online: 0,
    offline: 0,
    stale: 0,
    unknown: 0
  };

  for (const g of rawGateways) {
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
    }

    if (runtimeStatus === 'ONLINE') gateways.online++;
    else if (runtimeStatus === 'STALE') gateways.stale++;
    else if (runtimeStatus === 'OFFLINE') gateways.offline++;
    else gateways.unknown++;
  }

  // Operational Attention items
  const attention = [];
  if (unpositioned > 0) {
    attention.push({
      type: 'UNPOSITIONED_INSTRUMENTS',
      count: unpositioned,
      label: `${unpositioned} ${unpositioned === 1 ? 'Instrument' : 'Instruments'} without coordinates`,
      action: 'COMMISSIONING'
    });
  }
  if (noTelemetry > 0) {
    attention.push({
      type: 'NO_TELEMETRY',
      count: noTelemetry,
      label: `${noTelemetry} ${noTelemetry === 1 ? 'Instrument' : 'Instruments'} without telemetry`
    });
  }
  const s2OrHigher = severity.S2 + severity.S3 + severity.S4;
  if (s2OrHigher > 0) {
    attention.push({
      type: 'HIGH_SEVERITY',
      count: s2OrHigher,
      label: `${s2OrHigher} ${s2OrHigher === 1 ? 'Instrument' : 'Instruments'} at S2 or higher`
    });
  }
  if (quality.invalid > 0) {
    attention.push({
      type: 'INVALID_QUALITY',
      count: quality.invalid,
      label: `${quality.invalid} ${quality.invalid === 1 ? 'Instrument' : 'Instruments'} with Invalid quality`
    });
  }
  if (devices.offline > 0) {
    attention.push({
      type: 'DEVICES_OFFLINE',
      count: devices.offline,
      label: `${devices.offline} ${devices.offline === 1 ? 'Device' : 'Devices'} offline`
    });
  }
  if (gateways.offline > 0) {
    attention.push({
      type: 'GATEWAYS_OFFLINE',
      count: gateways.offline,
      label: `${gateways.offline} ${gateways.offline === 1 ? 'Gateway' : 'Gateways'} offline`
    });
  }

  // Real Reporting Instruments Summary
  const latestReadings = summaries
    .filter(s => s.latest?.engineeringValue !== null || s.latest?.rawValue !== null)
    .map(s => ({
      instrumentId: s.instrument._id,
      code: s.instrument.code,
      name: s.instrument.name,
      parameter: s.latest.channelLabel || s.latest.parameterCode,
      parameterCode: s.latest.parameterCode,
      value: s.latest.engineeringValue ?? s.latest.rawValue,
      unit: s.latest.unit,
      quality: s.operational.quality,
      severity: s.operational.severity,
      health: s.operational.health,
      observedAt: s.latest.timestamp
    }));

  // Real Telemetry Trend History aligned by minute
  const timeBuckets = new Map();
  for (const r of derivedHistory) {
    const d = new Date(r.observedAt);
    const timeKey = d.toISOString().slice(0, 16).replace('T', ' ');
    if (!timeBuckets.has(timeKey)) timeBuckets.set(timeKey, { t: timeKey });
    const b = timeBuckets.get(timeKey);
    if (r.parameterCode === 'x_displacement') b['Movement X'] = r.value;
    else if (r.parameterCode === 'y_displacement') b['Movement Y'] = r.value;
    else if (r.parameterCode === 'pore_pressure') b['Pore pressure'] = r.value;
    else if (r.parameterCode === 'temperature') b['Temperature'] = r.value;
  }
  const trendData = Array.from(timeBuckets.values());

  // Real Site Visual Geometry & Positioned Markers
  const siteVisual = {
    features: features.map(f => ({
      id: f._id,
      name: f.name,
      type: f.geometry?.type,
      coordinates: f.geometry?.coordinates,
      category: f.category || 'SITE'
    })),
    markers: summaries
      .filter(s => s.location?.longitude !== null && s.location?.latitude !== null && Number.isFinite(s.location?.longitude) && Number.isFinite(s.location?.latitude) && !(s.location.longitude === 0 && s.location.latitude === 0))
      .map(s => ({
        id: s.instrument._id,
        code: s.instrument.code,
        name: s.instrument.name,
        coordinates: [s.location.longitude, s.location.latitude],
        severity: s.operational.severity,
        quality: s.operational.quality,
        health: s.operational.health,
        value: s.latest?.engineeringValue ?? s.latest?.rawValue ?? null,
        unit: s.latest?.unit || ''
      }))
  };

  const coverage = {
    total,
    reporting: latestReadings.length,
    percentage: Math.round((latestReadings.length / (total || 1)) * 100),
    positioned
  };

  const highestSeverity = severity.S4 > 0 ? 'S4' :
    severity.S3 > 0 ? 'S3' :
    severity.S2 > 0 ? 'S2' :
    severity.S1 > 0 ? 'S1' :
    severity.S0 > 0 ? 'S0' : 'Not evaluated';

  const evaluatedInstruments = total - severity.notEvaluated;

  // Real latest decision if present
  const latestDecisionDoc = recentDecisions[0] || null;
  const decision = latestDecisionDoc ? {
    id: latestDecisionDoc._id,
    decisionCode: latestDecisionDoc.decisionCode,
    evaluatedAt: latestDecisionDoc.evaluatedAt,
    severity: latestDecisionDoc.severity,
    severityFloor: latestDecisionDoc.severityFloor,
    monitoringHealth: latestDecisionDoc.monitoringHealth,
    state: latestDecisionDoc.state,
    reasonCodes: latestDecisionDoc.reasonCodes || [],
    recommendedActions: latestDecisionDoc.recommendedActions || []
  } : null;

  // Legacy fields for report.service.js and backward compatibility
  const latestDecisionByScope = new Map();
  for (const d of recentDecisions) {
    const key = d.instrumentId?.toString() || 'PROJECT';
    if (!latestDecisionByScope.has(key)) latestDecisionByScope.set(key, d);
  }
  const currentDecisions = [...latestDecisionByScope.values()];
  const baseStatus = deriveOperationalStatus(currentDecisions);
  const monitoringHealth = maxHealth([
    ...currentDecisions.map((d) => d.monitoringHealth),
    ...rawDevices.map((d) => d.healthGrade || 'H0')
  ]);
  const status = { ...baseStatus, monitoringHealth };

  const latestByParam = {};
  for (const x of latest) if (!latestByParam[x.parameterCode]) latestByParam[x.parameterCode] = x;

  return {
    project: {
      id: project._id,
      name: project.name,
      code: project.code,
      location: project.location,
      timezone: project.timezone,
      status: project.status,
      setupStatus: project.setupStatus || null,
      useCaseCode: project.useCaseCode,
      useCaseName: project.templateName || project.useCaseTemplateId?.name || project.useCaseCode || 'General Monitoring'
    },
    instruments: {
      total,
      positioned,
      unpositioned,
      noTelemetry
    },
    severity,
    health,
    quality,
    devices,
    gateways,
    attention,
    coverage,
    highestSeverity,
    evaluatedInstruments,
    latestReadings,
    trendData,
    siteVisual,
    decision,
    // Backward compatibility
    status,
    counts: {
      instruments: total,
      devices: rawDevices.length,
      onlineDevices: devices.online,
      openAlarms: alarms.length
    },
    latest: Object.values(latestByParam).map((x) => ({
      parameterCode: x.parameterCode,
      value: x.value,
      unit: x.unit,
      quality: x.quality,
      observedAt: x.observedAt,
      severity: x.severity
    })),
    alarms: alarms.slice(0, 10).map((a) => ({
      id: a._id,
      type: a.type,
      title: a.title,
      severity: a.severity,
      healthGrade: a.healthGrade,
      state: a.state,
      reasonCodes: a.reasonCodes,
      openedAt: a.openedAt
    }))
  };
}
