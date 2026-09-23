import crypto from 'node:crypto';
import { DerivedReading, Project, RawReading, SensorChannel } from '../models/index.js';
import { evaluateQuality } from './quality.service.js';
import { deriveChannelReading, deriveCrossChannelMetrics } from './engineering.service.js';
import { evaluateRules } from './rule.service.js';
import { createDecision } from './decision.service.js';
import { recordDeviceHealth } from './health.service.js';
import { ApiError } from '../utils/api-error.js';

function normalizeChannels(payload) {
  if (Array.isArray(payload.readings)) return payload.readings.map((r) => ({ channelCode: r.channelCode || r.code, rawValue: r.rawValue ?? r.value, unit: r.unit }));
  if (payload.channels && typeof payload.channels === 'object') return Object.entries(payload.channels).map(([channelCode, rawValue]) => ({ channelCode, rawValue }));
  return [];
}

export async function processTelemetry({ device, payload, emit = () => {} }) {
  const project = await Project.findById(device.projectId);
  if (!project) throw new ApiError(404, 'Project not found for device');
  const sampleTime = new Date(payload.sampleTime || payload.timestamp || Date.now());
  if (Number.isNaN(sampleTime.getTime())) throw new ApiError(400, 'Invalid sampleTime');
  const readings = normalizeChannels(payload);
  if (!readings.length) throw new ApiError(400, 'No telemetry readings supplied');
  if (payload.health) await recordDeviceHealth(device, sampleTime, payload.health, emit);
  else { device.lastSeenAt = sampleTime; device.status = 'ONLINE'; await device.save(); }

  const createdRaw = [];
  const derived = [];
  for (const input of readings) {
    const channel = await SensorChannel.findOne({ projectId: project._id, deviceId: device._id, $or: [{ code: input.channelCode }, { sourceField: input.channelCode }] });
    if (!channel) continue;
    const existing = payload.messageId ? await RawReading.findOne({ deviceId: device._id, messageId: String(payload.messageId), channelCode: channel.code }).lean() : null;
    if (existing) continue;
    const previousDerived = await DerivedReading.findOne({ channelId: channel._id }).sort({ observedAt: -1 }).lean();
    const q = evaluateQuality({ rawValue: input.rawValue, channel, sampleTime, previousDerived });
    const raw = await RawReading.create({
      ingestionId: crypto.randomUUID(),
      sourceEventId: payload.sourceEventId || payload.messageId,
      organizationId: device.organizationId,
      projectId: project._id,
      deviceId: device._id,
      instrumentId: channel.instrumentId,
      channelId: channel._id,
      channelCode: channel.code,
      sampleTime,
      messageId: payload.messageId ? String(payload.messageId) : undefined,
      sequenceNumber: payload.sequenceNumber,
      rawValue: input.rawValue,
      rawUnit: input.unit || channel.rawUnit,
      quality: q.quality,
      qualityReasons: q.reasons,
      parserVersion: payload.schemaVersion || '1.0',
      sourceMetadata: { transport: device.transport, ...(payload.meta || {}) },
      originalPacket: payload
    });
    createdRaw.push(raw);
    if (q.quality !== 'INVALID') derived.push(await deriveChannelReading({ rawReading: raw, channel }));
  }
  const cross = await deriveCrossChannelMetrics(derived);
  const allDerived = [...derived, ...cross];
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
  emit('telemetry.updated', { projectId: project._id, deviceId: device.deviceId, sampleTime, readings: allDerived.map((r) => ({ instrumentId: r.instrumentId, parameterCode: r.parameterCode, value: r.value, unit: r.unit, quality: r.quality })) });
  return { acceptedRaw: createdRaw.length, derived: allDerived.length, decisions: decisions.map((d) => ({ id: d._id, code: d.decisionCode, severity: d.severity, health: d.monitoringHealth, confidence: d.confidence })) };
}
