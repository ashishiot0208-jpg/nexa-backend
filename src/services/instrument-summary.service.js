import {
  Alarm,
  DecisionSnapshot,
  Device,
  DeviceGatewayMapping,
  DerivedReading,
  Instrument,
  InstrumentCatalog,
  LatestState,
  Project,
  ProjectGateway,
  RawReading,
  RuleSet,
  Sensor,
  SensorChannel,
  SensorDeviceMapping,
  Site,
  Zone
} from '../models/index.js';
import { resolveApplicableRule, evaluateSeverity } from './severity.service.js';

/**
 * Builds the canonical operational summary for an instrument.
 * Reusable by Instrument Detail, Instrument Register, Overview, Map, Alarms, Reports.
 */
export async function getInstrumentOperationalSummary(instrumentId, organizationId = null) {
  const query = { _id: instrumentId };
  if (organizationId) query.organizationId = organizationId;

  const instrument = await Instrument.findOne(query).lean();
  if (!instrument) return null;

  // 1. Catalogue Metadata
  let catalogue = null;
  if (instrument.sensor_uid || instrument.catalogCode) {
    catalogue = await Sensor.findOne({
      $or: [
        { uid: instrument.sensor_uid },
        { uid: instrument.catalogCode }
      ]
    }).lean();
  }
  if (!catalogue && instrument.catalogCode) {
    catalogue = await InstrumentCatalog.findOne({ code: instrument.catalogCode }).lean();
  }

  const typeName = catalogue?.name ||
    (instrument.catalogCode === 'SNS000009' ? 'Automatic Inclinometer' :
     instrument.catalogCode?.includes('INCL') ? 'Automatic Inclinometer' :
     instrument.catalogCode?.includes('PIEZ') ? 'Vibrating Wire Piezometer' :
     instrument.name || 'Unknown Type');

  const model = catalogue?.model || instrument.metadata?.model || '—';

  // 2. Site / Zone
  let siteName = '—';
  if (instrument.siteId) {
    const siteDoc = await Site.findById(instrument.siteId).lean();
    if (siteDoc) siteName = siteDoc.name;
  }

  let zoneName = '—';
  if (instrument.zoneId) {
    const zoneDoc = await Zone.findById(instrument.zoneId).lean();
    if (zoneDoc) zoneName = zoneDoc.name;
  }

  // 3. Location & Coordinates (Stored as [longitude, latitude] in GeoJSON/Mongo order)
  const coordinates = Array.isArray(instrument.coordinates) ? instrument.coordinates : null;
  const longitude = coordinates && Number.isFinite(coordinates[0]) ? coordinates[0] : null;
  const latitude = coordinates && Number.isFinite(coordinates[1]) ? coordinates[1] : null;
  const depthM = Number.isFinite(instrument.depthM) ? instrument.depthM : null;
  const orientationDeg = Number.isFinite(instrument.orientationDeg) ? instrument.orientationDeg : null;
  const installDate = instrument.installDate || instrument.commissionedAt || null;

  // 4. SensorChannels
  const channels = await SensorChannel.find({ instrumentId: instrument._id }).lean();

  // 5. SensorDeviceMapping & DeviceGatewayMapping
  const sdm = await SensorDeviceMapping.findOne({
    projectId: instrument.projectId,
    sensorAssetId: instrument._id,
    status: 'ACTIVE'
  }).populate('deviceAssetId').lean();

  let connection = {
    device: null,
    slot: null,
    gateway: null
  };

  if (sdm && sdm.deviceAssetId) {
    const dev = sdm.deviceAssetId;
    const slot = sdm.connection?.slot ?? 1;

    // Check device runtime freshness
    const now = Date.now();
    const intervalMs = Math.max(60, dev.expectedIntervalSec || 900) * 1000;
    const lastSeenMs = dev.lastSeenAt ? new Date(dev.lastSeenAt).getTime() : 0;
    const isDeviceFresh = dev.lastSeenAt && (now - lastSeenMs < intervalMs * 4);

    connection.slot = slot;
    connection.device = {
      id: dev._id,
      deviceId: dev.deviceId,
      name: dev.name,
      status: dev.status,
      runtimeStatus: isDeviceFresh ? 'ONLINE' : (dev.lastSeenAt ? 'OFFLINE' : 'Unknown'),
      lastSeenAt: dev.lastSeenAt || null,
      healthGrade: dev.healthGrade || 'H0'
    };

    // Device -> Gateway mapping
    const dgm = await DeviceGatewayMapping.findOne({
      projectId: instrument.projectId,
      deviceAssetId: dev._id,
      status: 'ACTIVE'
    }).populate('gatewayAssetId').lean();

    if (dgm && dgm.gatewayAssetId) {
      const gw = dgm.gatewayAssetId;
      const gwLastSeen = gw.metadata?.lastSeenAt ? new Date(gw.metadata.lastSeenAt).getTime() : null;
      const isGwFresh = gwLastSeen && (now - gwLastSeen < intervalMs * 4);

      connection.gateway = {
        id: gw._id,
        gatewayId: gw.gatewayId,
        name: gw.name,
        status: gw.status,
        runtimeStatus: isGwFresh ? 'ONLINE' : 'Unknown / No telemetry',
        lastSeenAt: gw.metadata?.lastSeenAt || null
      };
    }
  }

  // 6. Determine display channel deterministically
  // Rules:
  // - Inclinometer: prefer 'x_displacement', then any displacement channel, then first
  // - Piezometer: prefer 'pore_pressure', then pressure channel, then first
  // - Other: first non-temperature channel, else first channel
  let displayChannel = null;
  const isInc = (catalogue?.type === 'inclinometer') ||
                instrument.catalogCode?.includes('INC') ||
                channels.some(c => c.parameterCode?.includes('disp'));
  const isPz = (catalogue?.type === 'piezometer') ||
               instrument.catalogCode?.includes('PZ') ||
               channels.some(c => c.parameterCode?.includes('pressure'));

  if (isInc) {
    displayChannel = channels.find(c => c.parameterCode === 'x_displacement' || c.code === 'x_displacement') ||
                     channels.find(c => c.parameterCode?.includes('disp')) ||
                     channels[0];
  } else if (isPz) {
    displayChannel = channels.find(c => c.parameterCode === 'pore_pressure' || c.code === 'pore_pressure') ||
                     channels.find(c => c.parameterCode?.includes('pressure')) ||
                     channels[0];
  } else {
    displayChannel = channels.find(c => !c.parameterCode?.includes('temp')) || channels[0];
  }

  function getHumanChannelLabel(codeOrParam) {
    if (!codeOrParam) return 'Primary channel';
    const s = codeOrParam.toLowerCase();
    if (s.includes('x_disp') || s === 'x_displacement') return 'X displacement';
    if (s.includes('y_disp') || s === 'y_displacement') return 'Y displacement';
    if (s.includes('resultant')) return 'Resultant displacement';
    if (s.includes('pore_pressure') || s.includes('pressure')) return 'Pore pressure';
    if (s.includes('temperature') || s === 'temperature') return 'Temperature';
    return codeOrParam.replace(/_/g, ' ');
  }

  const displayChannelLabel = getHumanChannelLabel(displayChannel?.code || displayChannel?.parameterCode);

  // 7. Latest Telemetry & Traceability to RawReading
  let latestDerived = null;
  let latestRaw = null;

  if (displayChannel) {
    latestDerived = await DerivedReading.findOne({
      instrumentId: instrument._id,
      parameterCode: displayChannel.parameterCode
    }).sort({ observedAt: -1 }).lean();

    if (latestDerived?.rawReadingId) {
      latestRaw = await RawReading.findById(latestDerived.rawReadingId).lean();
    } else {
      latestRaw = await RawReading.findOne({
        instrumentId: instrument._id,
        channelCode: displayChannel.code
      }).sort({ sampleTime: -1 }).lean();
    }
  }

  // 8. Baseline for display channel
  const baselineConfigured = displayChannel?.baseline?.configured === true;
  const baselineValue = baselineConfigured ? Number(displayChannel.baseline.value ?? 0) : null;

  // 9. Operational Metrics: Rate, Quality, Severity, Health, Confidence
  // Rate: Only valid if actually computed from measurement history
  const ratePerHour = (latestDerived && Number.isFinite(latestDerived.ratePerHour))
    ? latestDerived.ratePerHour
    : null;

  // Quality: Real evaluated quality or NOT EVALUATED
  const quality = latestDerived?.quality || (latestRaw?.quality && latestRaw.quality !== 'PENDING' ? latestRaw.quality : 'NOT EVALUATED');

  // S-Level (Geotechnical / Engineering Severity):
  let severity = 'NOT EVALUATED';
  if (latestDerived?.severity?.evaluated && latestDerived.severity.level) {
    severity = latestDerived.severity.level;
  } else if (displayChannel && latestDerived) {
    const applicableRule = await resolveApplicableRule({
      projectId: instrument.projectId,
      instrumentId: instrument._id,
      catalogCode: instrument.catalogCode,
      parameterCode: displayChannel.parameterCode
    });
    if (applicableRule) {
      const sev = evaluateSeverity({
        instrument,
        channel: displayChannel,
        derivedReading: latestDerived,
        quality: latestDerived.quality,
        applicableRule
      });
      if (sev.evaluated) {
        severity = sev.level;
      }
    }
  }

  // If still not evaluated, check LatestState for explicit evaluated severity
  if (severity === 'NOT EVALUATED' && displayChannel) {
    const ls = await LatestState.findOne({
      instrumentId: instrument._id,
      parameterCode: displayChannel.parameterCode
    }).lean();
    if (ls?.severityDetails?.evaluated && ls.severityDetails.level) {
      severity = ls.severityDetails.level;
    } else if (ls?.severity && ['S0', 'S1', 'S2', 'S3', 'S4'].includes(ls.severity) && ls.severityDetails?.evaluated) {
      severity = ls.severity;
    }
  }

  // H-Level (Monitoring System Health):
  // Derive from actual device connectivity and telemetry health
  let health = 'NOT EVALUATED';
  if (connection.device?.lastSeenAt) {
    const nowMs = Date.now();
    const age = nowMs - new Date(connection.device.lastSeenAt).getTime();
    const interval = (sdm.deviceAssetId?.expectedIntervalSec || 900) * 1000;
    if (age <= interval * 2) health = 'H0';
    else if (age <= interval * 4) health = 'H1';
    else if (age <= interval * 12) health = 'H2';
    else health = 'H3';
  }

  // Confidence:
  // Must NOT be fake or hardcoded 85%. If no approved engineering rules exist, NOT EVALUATED
  let confidence = null;
  if (severity !== 'NOT EVALUATED') {
    const decision = await DecisionSnapshot.findOne({ instrumentId: instrument._id })
      .sort({ evaluatedAt: -1 })
      .lean();
    if (Number.isFinite(decision?.confidence)) {
      confidence = decision.confidence;
    }
  }

  // 10. Multi-channel Analysis Map (e.g. for Inclinometer / Piezometer technical panels)
  const channelStates = {};
  for (const ch of channels) {
    const d = await DerivedReading.findOne({
      instrumentId: instrument._id,
      parameterCode: ch.parameterCode
    }).sort({ observedAt: -1 }).lean();

    channelStates[ch.code] = {
      code: ch.code,
      parameterCode: ch.parameterCode,
      label: getHumanChannelLabel(ch.code),
      value: d ? d.value : null,
      unit: d ? d.unit : (ch.engineeringUnit || ch.rawUnit),
      deltaFromBaseline: d ? d.deltaFromBaseline : null,
      ratePerHour: d ? d.ratePerHour : null,
      accelerationPerHour2: d ? d.accelerationPerHour2 : null,
      quality: d ? d.quality : 'NOT EVALUATED',
      severity: d?.severity?.evaluated ? d.severity.level : 'NOT EVALUATED',
      severityDetails: d?.severity || null,
      observedAt: d ? d.observedAt : null,
      calibration: {
        configured: ch.calibration?.configured === true,
        source: ch.calibration?.source || (ch.calibration?.configured ? 'DEVICE_NATIVE' : '—'),
        scale: ch.calibration?.scale ?? 1,
        offset: ch.calibration?.offset ?? 0,
        version: ch.calibration?.version || 1
      },
      baseline: {
        configured: ch.baseline?.configured === true,
        value: ch.baseline?.value ?? 0,
        version: ch.baseline?.version || 1
      }
    };
  }

  // 11. Alarms
  const alarms = await Alarm.find({
    instrumentId: instrument._id,
    state: { $nin: ['CONDITION_NORMALIZED', 'CLOSED'] }
  }).lean();

  return {
    instrument: {
      ...instrument,
      typeName,
      model,
      siteName,
      zoneName
    },
    catalogue: catalogue ? {
      name: catalogue.name,
      model: catalogue.model,
      type: catalogue.type,
      uid: catalogue.uid
    } : null,
    location: {
      siteName,
      zoneName,
      longitude,
      latitude,
      depthM,
      orientationDeg,
      installDate
    },
    connection,
    channels: channels.map(c => ({
      _id: c._id,
      code: c.code,
      parameterCode: c.parameterCode,
      label: getHumanChannelLabel(c.code),
      rawUnit: c.rawUnit,
      engineeringUnit: c.engineeringUnit,
      calibration: {
        configured: c.calibration?.configured === true,
        source: c.calibration?.source || (c.calibration?.configured ? 'DEVICE_NATIVE' : '—'),
        scale: c.calibration?.scale ?? 1,
        offset: c.calibration?.offset ?? 0
      },
      baseline: {
        configured: c.baseline?.configured === true,
        value: c.baseline?.value ?? 0
      }
    })),
    displayChannel: displayChannel ? {
      code: displayChannel.code,
      parameterCode: displayChannel.parameterCode,
      label: displayChannelLabel
    } : null,
    latest: {
      channelCode: displayChannel?.code || null,
      parameterCode: displayChannel?.parameterCode || null,
      channelLabel: displayChannelLabel,
      rawValue: latestRaw ? latestRaw.rawValue : null,
      rawUnit: latestRaw ? latestRaw.rawUnit : (displayChannel?.rawUnit || ''),
      rawTimestamp: latestRaw ? latestRaw.sampleTime : null,
      engineeringValue: latestDerived ? latestDerived.value : null,
      baselineValue: baselineValue,
      deltaFromBaseline: latestDerived ? latestDerived.deltaFromBaseline : null,
      unit: latestDerived ? latestDerived.unit : (displayChannel?.engineeringUnit || displayChannel?.rawUnit || ''),
      timestamp: latestDerived ? latestDerived.observedAt : (latestRaw ? latestRaw.sampleTime : null),
      source: latestDerived?.metadata?.source || latestRaw?.sourceMetadata?.source || null
    },
    operational: {
      rate: ratePerHour,
      quality,
      severity,
      health,
      confidence
    },
    channelStates,
    alarms
  };
}
