import { Device, DeviceTelemetry } from '../models/index.js';
import { maxHealth } from '../utils/severity.js';

export function gradeDeviceHealth({ batteryV, rssiDbm, faultBits = [] } = {}) {
  if (faultBits?.includes('CRITICAL')) return 'H3';
  if (Number.isFinite(batteryV) && batteryV < 3.2) return 'H2';
  if (Number.isFinite(rssiDbm) && rssiDbm < -105) return 'H2';
  if ((Number.isFinite(batteryV) && batteryV < 3.45) || (Number.isFinite(rssiDbm) && rssiDbm < -95)) return 'H1';
  return 'H0';
}

export async function recordDeviceHealth(device, sampleTime, health = {}, emit = () => {}) {
  const grade = gradeDeviceHealth(health);
  const doc = await DeviceTelemetry.create({
    organizationId: device.organizationId,
    projectId: device.projectId,
    deviceId: device._id,
    observedAt: sampleTime,
    batteryV: health.batteryV,
    rssiDbm: health.rssiDbm,
    network: health.network,
    internalTempC: health.internalTempC,
    resetCount: health.resetCount,
    memoryFree: health.memoryFree,
    faultBits: health.faultBits || [],
    healthGrade: grade,
    metadata: health.metadata || {}
  });
  device.lastSeenAt = sampleTime;
  device.lastBatteryV = health.batteryV ?? device.lastBatteryV;
  device.lastRssiDbm = health.rssiDbm ?? device.lastRssiDbm;
  device.healthGrade = grade;
  device.status = 'ONLINE';
  await device.save();
  emit('device.health_changed', { deviceId: device.deviceId, projectId: device.projectId, healthGrade: grade, observedAt: sampleTime });
  return doc;
}

export async function refreshMissingDataHealth({ now = new Date(), emit = () => {} } = {}) {
  const devices = await Device.find({ status: { $nin: ['DECOMMISSIONED', 'PLANNED'] } });
  let changed = 0;
  for (const device of devices) {
    const interval = Math.max(60, device.expectedIntervalSec || 900) * 1000;
    const age = device.lastSeenAt ? now.getTime() - device.lastSeenAt.getTime() : Infinity;
    let grade = device.healthGrade || 'H0';
    let status = device.status;
    if (age > interval * 12) { grade = 'H3'; status = 'OFFLINE'; }
    else if (age > interval * 4) { grade = maxHealth([grade, 'H2']); status = 'OFFLINE'; }
    else if (age > interval * 2) { grade = maxHealth([grade, 'H1']); }
    if (grade !== device.healthGrade || status !== device.status) {
      device.healthGrade = grade;
      device.status = status;
      await device.save();
      changed += 1;
      emit('device.health_changed', { deviceId: device.deviceId, projectId: device.projectId, healthGrade: grade, status, observedAt: now });
    }
  }
  return changed;
}
