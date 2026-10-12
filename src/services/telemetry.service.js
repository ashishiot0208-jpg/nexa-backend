import crypto from 'node:crypto';
import {
  DerivedReading,
  Device,
  DeviceGatewayMapping,
  Instrument,
  LatestState,
  Project,
  ProjectGateway,
  RawReading,
  SensorChannel,
  SensorDeviceMapping
} from '../models/index.js';
import { evaluateQuality } from './quality.service.js';
import { deriveChannelReading, deriveCrossChannelMetrics } from './engineering.service.js';
import { evaluateRules } from './rule.service.js';
import { createDecision } from './decision.service.js';
import { recordDeviceHealth } from './health.service.js';
import { ApiError } from '../utils/api-error.js';

/**
 * Normalizes incoming readings into slot-grouped records:
 * Array of { slot: Number, values: { [channelCode]: rawValue } }
 */
function normalizeIncomingReadings(packet) {
  const slotGroups = new Map();

  function addToSlot(slot, channelCode, val) {
    const s = Number.isInteger(Number(slot)) ? Number(slot) : 1;
    if (!slotGroups.has(s)) slotGroups.set(s, {});
    slotGroups.get(s)[channelCode] = val;
  }

  // Case 1: packet.readings array
  if (Array.isArray(packet.readings)) {
    for (const r of packet.readings) {
      if (!r || typeof r !== 'object') continue;
      const slot = r.slot ?? r.address ?? 1;
      // Subcase 1a: readings has a values map { x: 1, y: 2 }
      if (r.values && typeof r.values === 'object') {
        for (const [k, v] of Object.entries(r.values)) {
          addToSlot(slot, k, v);
        }
      } else if (r.channelCode || r.code) {
        // Subcase 1b: flat reading entry { slot: 1, channelCode: 'x', rawValue: 1 }
        const code = r.channelCode || r.code;
        const val = r.rawValue ?? r.value;
        addToSlot(slot, code, val);
      }
    }
  }

  // Case 2: packet.channels object { x: 1, y: 2 }
  if (packet.channels && typeof packet.channels === 'object') {
    const defaultSlot = Number.isInteger(Number(packet.slot)) ? Number(packet.slot) : 1;
    for (const [k, v] of Object.entries(packet.channels)) {
      addToSlot(defaultSlot, k, v);
    }
  }

  // Case 3: packet.values object { x: 1, y: 2 }
  if (packet.values && typeof packet.values === 'object' && !packet.readings) {
    const defaultSlot = Number.isInteger(Number(packet.slot)) ? Number(packet.slot) : 1;
    for (const [k, v] of Object.entries(packet.values)) {
      addToSlot(defaultSlot, k, v);
    }
  }

  const result = [];
  for (const [slot, values] of slotGroups.entries()) {
    result.push({ slot, values });
  }
  return result;
}

/**
 * Canonical Ingestion Service
 * Ingests a telemetry packet through the full processing pipeline:
 * Device resolution -> Gateway validation -> Slot/SensorDeviceMapping resolution
 * -> SensorChannel resolution -> Calibration -> Baseline -> Persistence -> LatestState
 */
export async function ingestTelemetry(packet, { emit = () => {}, source = null } = {}) {
  if (!packet || typeof packet !== 'object') {
    throw new ApiError(400, 'Payload must be a JSON object');
  }

  // 1. Resolve Device Identity
  const deviceCode = packet.deviceCode || packet.deviceId;
  if (!deviceCode) {
    throw new ApiError(400, 'deviceCode (or deviceId) is required');
  }

  const device = await Device.findOne({ deviceId: deviceCode });
  if (!device) {
    throw new ApiError(404, `Unknown Device: ${deviceCode}`);
  }

  // Verify Project
  const project = await Project.findById(device.projectId);
  if (!project) {
    throw new ApiError(404, `Project not found for device: ${deviceCode}`);
  }

  // Lifecycle check: accept operational telemetry only for commissioned device
  const isDeviceCommissioned =
    device.commissioningStatus === 'COMMISSIONED' || device.status === 'COMMISSIONED';
  if (!isDeviceCommissioned) {
    throw new ApiError(400, `Device '${deviceCode}' is not commissioned (status: ${device.status || device.commissioningStatus})`);
  }

  // 2. Gateway Validation
  const gwCode = packet.gatewayCode || packet.gatewayId;
  let gateway = null;
  if (gwCode) {
    gateway = await ProjectGateway.findOne({ projectId: project._id, gatewayId: gwCode });
    if (!gateway) {
      throw new ApiError(404, `Unknown Gateway: ${gwCode}`);
    }

    const activeDgm = await DeviceGatewayMapping.findOne({
      projectId: project._id,
      deviceAssetId: device._id,
      status: 'ACTIVE'
    }).populate('gatewayAssetId');

    if (activeDgm) {
      const mappedGwCode = activeDgm.gatewayAssetId?.gatewayId;
      if (mappedGwCode && mappedGwCode !== gwCode) {
        throw new ApiError(400, `Incompatible Gateway mapping: Device '${deviceCode}' is mapped to Gateway '${mappedGwCode}', but packet specified '${gwCode}'`);
      }
    }
  }

  // 3. Timestamp Validation
  const rawTimestamp = packet.timestamp || packet.sampleTime;
  if (!rawTimestamp) {
    throw new ApiError(400, 'timestamp (or sampleTime) is required');
  }
  const sampleTime = new Date(rawTimestamp);
  if (Number.isNaN(sampleTime.getTime())) {
    throw new ApiError(400, `Invalid timestamp format: ${rawTimestamp}`);
  }
  if (sampleTime.getFullYear() < 2000 || sampleTime.getFullYear() > 2100) {
    throw new ApiError(400, `Timestamp year out of valid range: ${sampleTime.toISOString()}`);
  }

  // 4. Source Marking
  const isSimulator =
    String(packet.source || source || '').toUpperCase() === 'SIMULATOR';
  const sourceTag = isSimulator ? 'SIMULATOR' : (packet.source || source || 'DEVICE');

  // 5. Duplicate Packet Protection (Idempotency)
  if (packet.messageId) {
    const existingRaw = await RawReading.findOne({
      deviceId: device._id,
      messageId: String(packet.messageId)
    }).lean();

    if (existingRaw) {
      return {
        accepted: true,
        duplicate: true,
        device: device.deviceId,
        messageId: packet.messageId,
        resolvedSensors: 0,
        processedChannels: 0,
        storedMeasurements: 0,
        source: sourceTag,
        message: 'Duplicate packet ignored'
      };
    }
  }

  // Handle optional device health payload
  if (packet.health) {
    await recordDeviceHealth(device, sampleTime, packet.health, emit);
  }

  // 6. Normalize readings into slot groups
  const slotGroups = normalizeIncomingReadings(packet);
  if (!slotGroups.length) {
    throw new ApiError(400, 'No telemetry readings supplied in packet');
  }

  const errors = [];
  const createdRaw = [];
  const derived = [];
  const resolvedInstrumentIds = new Set();

  // 7. Process each slot group
  for (const { slot, values } of slotGroups) {
    // 7a. Device -> SensorDeviceMapping resolution
    const sdm = await SensorDeviceMapping.findOne({
      projectId: project._id,
      deviceAssetId: device._id,
      'connection.slot': slot,
      status: 'ACTIVE'
    }).populate('sensorAssetId');

    if (!sdm || !sdm.sensorAssetId) {
      errors.push({
        slot,
        reason: 'UNKNOWN_SLOT',
        message: `No active SensorDeviceMapping for device '${device.deviceId}' slot ${slot}`
      });
      continue;
    }

    const instrument = sdm.sensorAssetId;
    if (instrument.status !== 'COMMISSIONED') {
      errors.push({
        slot,
        instrumentCode: instrument.code,
        reason: 'INSTRUMENT_NOT_COMMISSIONED',
        message: `Instrument '${instrument.code}' is not COMMISSIONED (status: ${instrument.status})`
      });
      continue;
    }
    resolvedInstrumentIds.add(instrument._id.toString());

    // 7b. Instrument -> SensorChannel resolution
    const sensorChannels = await SensorChannel.find({
      projectId: project._id,
      instrumentId: instrument._id
    });

    if (!sensorChannels.length) {
      errors.push({
        slot,
        instrumentCode: instrument.code,
        reason: 'NO_SENSOR_CHANNELS',
        message: `No SensorChannels found for instrument '${instrument.code}'`
      });
      continue;
    }

    // Build channel lookup map (code, sourceField, parameterCode)
    const channelMap = new Map();
    for (const ch of sensorChannels) {
      if (ch.code) channelMap.set(ch.code.toLowerCase(), ch);
      if (ch.sourceField) channelMap.set(ch.sourceField.toLowerCase(), ch);
      if (ch.parameterCode) channelMap.set(ch.parameterCode.toLowerCase(), ch);
    }

    // 7c. Process channel values
    for (const [channelKey, rawVal] of Object.entries(values)) {
      const channel = channelMap.get(channelKey.toLowerCase());
      if (!channel) {
        errors.push({
          slot,
          channel: channelKey,
          reason: 'UNKNOWN_CHANNEL',
          message: `Unknown SensorChannel '${channelKey}' for instrument '${instrument.code}'`
        });
        // DO NOT silently invent schema or create channel
        continue;
      }

      const numVal = Number(rawVal);
      if (!Number.isFinite(numVal)) {
        errors.push({
          slot,
          channel: channelKey,
          reason: 'INVALID_NUMERIC',
          message: `Invalid numeric value for channel '${channelKey}': ${rawVal}`
        });
        continue;
      }

      // Check required calibration configuration
      if (channel.calibration?.required === true && !channel.calibration?.configured) {
        errors.push({
          slot,
          channel: channelKey,
          reason: 'CALIBRATION_NOT_CONFIGURED',
          message: `Calibration required but not configured for channel '${channel.code}'`
        });
        continue;
      }

      // 7d. Calibration calculation
      const scale = Number.isFinite(channel.calibration?.scale) ? channel.calibration.scale : 1;
      const offset = Number.isFinite(channel.calibration?.offset) ? channel.calibration.offset : 0;
      const engineeringValue = numVal * scale + offset;

      // 7e. Baseline calculation (delta only when configured)
      const deltaFromBaseline = channel.baseline?.configured === true
        ? engineeringValue - (channel.baseline?.value ?? 0)
        : null;

      // Quality evaluation
      const previousDerived = await DerivedReading.findOne({ channelId: channel._id })
        .sort({ observedAt: -1 })
        .lean();
      const q = evaluateQuality({ rawValue: numVal, channel, sampleTime, previousDerived });

      // 7f. Persist RawReading
      const raw = await RawReading.create({
        ingestionId: crypto.randomUUID(),
        sourceEventId: packet.messageId || packet.sourceEventId,
        organizationId: project.organizationId || device.organizationId,
        projectId: project._id,
        deviceId: device._id,
        instrumentId: instrument._id,
        channelId: channel._id,
        channelCode: channel.code,
        sampleTime,
        serverReceivedAt: new Date(),
        messageId: packet.messageId ? String(packet.messageId) : undefined,
        sequenceNumber: packet.sequenceNumber,
        rawValue: numVal,
        rawUnit: channel.rawUnit,
        quality: q.quality,
        qualityReasons: q.reasons,
        parserVersion: packet.parserVersion || '1.0',
        sourceMetadata: {
          source: sourceTag,
          transport: device.transport,
          gatewayCode: gwCode || undefined,
          slot
        },
        originalPacket: packet
      });
      createdRaw.push(raw);

      // 7g. Persist DerivedReading
      if (q.quality !== 'INVALID') {
        const derivedDoc = await deriveChannelReading({
          rawReading: raw,
          channel,
          sourceTag
        });
        derived.push(derivedDoc);
      }
    }
  }

  // 8. If nothing was created, handle controlled rejection
  if (createdRaw.length === 0) {
    if (errors.length > 0) {
      const summaryMsg = errors.map((e) => e.message).join('; ');
      throw new ApiError(400, `Telemetry ingestion rejected: ${summaryMsg}`, { errors });
    }
    throw new ApiError(400, 'No valid measurements processed from telemetry packet');
  }

  // 9. Update Device / Gateway runtime status
  device.lastSeenAt = sampleTime;
  await device.save();

  if (gateway) {
    gateway.set('metadata.lastSeenAt', sampleTime);
    await gateway.save();
  }

  // 10. Cross-channel metrics
  const cross = await deriveCrossChannelMetrics(derived);
  const allDerived = [...derived, ...cross];

  // 11. Update LatestState for every derived measurement
  for (const r of allDerived) {
    await LatestState.findOneAndUpdate(
      { instrumentId: r.instrumentId, parameterCode: r.parameterCode },
      {
        organizationId: r.organizationId,
        projectId: r.projectId,
        instrumentId: r.instrumentId,
        parameterCode: r.parameterCode,
        observedAt: r.observedAt,
        value: r.value,
        unit: r.unit,
        quality: r.quality,
        ratePerHour: r.ratePerHour
      },
      { upsert: true, new: true }
    );
  }

  // 12. Evaluate rules and decisions per instrument
  const byInstrument = new Map();
  for (const r of allDerived) {
    const k = r.instrumentId.toString();
    if (!byInstrument.has(k)) byInstrument.set(k, []);
    byInstrument.get(k).push(r);
  }
  const decisions = [];
  for (const [instrumentId, instrumentReadings] of byInstrument) {
    const rules = await evaluateRules({ project, derivedReadings: instrumentReadings });
    decisions.push(await createDecision({ project, instrumentId, derivedReadings: instrumentReadings, ruleEvaluation: rules, emit }));
  }

  // 13. Emit event
  emit('telemetry.updated', {
    projectId: project._id,
    deviceId: device.deviceId,
    sampleTime,
    source: sourceTag,
    readings: allDerived.map((r) => ({
      instrumentId: r.instrumentId,
      parameterCode: r.parameterCode,
      value: r.value,
      unit: r.unit,
      quality: r.quality,
      deltaFromBaseline: r.deltaFromBaseline
    }))
  });

  return {
    accepted: true,
    device: device.deviceId,
    resolvedSensors: resolvedInstrumentIds.size,
    processedChannels: createdRaw.length,
    storedMeasurements: createdRaw.length,
    source: sourceTag,
    warnings: errors.length ? errors : undefined
  };
}

/**
 * Backward compatibility wrapper
 */
export async function processTelemetry({ device, payload, emit = () => {} }) {
  const packet = {
    ...payload,
    deviceCode: payload.deviceCode || payload.deviceId || device?.deviceId
  };
  return ingestTelemetry(packet, { emit });
}
