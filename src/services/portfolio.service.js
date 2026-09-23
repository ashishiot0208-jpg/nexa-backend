import { DecisionSnapshot, Device, Instrument, LatestState, CameraSource, Alarm, SensorChannel, RawReading } from '../models/index.js';
import { deriveOperationalStatus } from './decision-status.service.js';

export async function getPortfolioSummary(projectIds) {
  if (!projectIds || projectIds.length === 0) return new Map();

  const query = { projectId: { $in: projectIds } };

  const [
    decisions, devices, instruments, cameras, alarms,
    channels, latestStates
  ] = await Promise.all([
    DecisionSnapshot.find(query).sort({ evaluatedAt: -1 }).lean(),
    Device.find(query).lean(),
    Instrument.find({ ...query, status: { $nin: ['PLANNED', 'DECOMMISSIONED'] } }).lean(),
    CameraSource.find(query).lean(),
    Alarm.find({ ...query, state: { $ne: 'CLOSED' } }).lean(),
    SensorChannel.find({ ...query, enabled: true }).lean(),
    LatestState.find(query).lean()
  ]);

  const groupBy = (arr, key) => arr.reduce((acc, obj) => {
    const k = obj[key]?.toString();
    if (!k) return acc;
    if (!acc.has(k)) acc.set(k, []);
    acc.get(k).push(obj);
    return acc;
  }, new Map());

  const pDecisions = groupBy(decisions, 'projectId');
  const pDevices = groupBy(devices, 'projectId');
  const pInstruments = groupBy(instruments, 'projectId');
  const pCameras = groupBy(cameras, 'projectId');
  const pAlarms = groupBy(alarms, 'projectId');
  const pChannels = groupBy(channels, 'projectId');
  const latestStatesByInst = groupBy(latestStates, 'instrumentId');

  // Compute Availability using Slot Coverage
  const now = new Date();
  const windowHours = 12;
  const windowStart = new Date(now.getTime() - (windowHours * 3600000));
  const windowEnd = now;

  const rawQuery = {
    projectId: { $in: projectIds },
    sampleTime: { $gte: windowStart, $lte: windowEnd }
  };

  const rawReadings = await RawReading.find(rawQuery)
    .select('channelId sampleTime')
    .lean();

  const readingsByChannel = groupBy(rawReadings, 'channelId');

  const summaryMap = new Map();

  for (const pid of projectIds) {
    const pidStr = pid.toString();
    const projDecisions = pDecisions.get(pidStr) || [];
    const projDevices = pDevices.get(pidStr) || [];
    const projInstruments = pInstruments.get(pidStr) || [];
    const projCameras = pCameras.get(pidStr) || [];
    const projAlarms = pAlarms.get(pidStr) || [];
    const projChannels = pChannels.get(pidStr) || [];

    // Latest Decision per evaluation scope
    const latestDecisionByScope = new Map();
    for (const d of projDecisions) {
      const key = d.instrumentId?.toString() || 'PROJECT';
      if (!latestDecisionByScope.has(key)) latestDecisionByScope.set(key, d);
    }
    const currentDecisions = [...latestDecisionByScope.values()];
    const baseStatus = deriveOperationalStatus(currentDecisions);

    const allHealths = currentDecisions.map(d => d.monitoringHealth).concat(projDevices.map(d => d.healthGrade || 'H0'));
    const hRank = h => parseInt(h.replace('H', '')) || 0;
    const finalHealth = allHealths.length > 0 ? `H${Math.max(...allHealths.map(hRank))}` : 'H0';
    
    const operationalStatus = { ...baseStatus, monitoringHealth: finalHealth };

    const gateways = projDevices.filter(d => d.deviceType === 'LOGGER' || d.deviceType === 'GATEWAY').length;
    const allDevicesCount = projDevices.length;
    const onlineDevices = projDevices.filter(d => d.status === 'ONLINE').length;
    const camerasCount = projCameras.length;

    let onlineInstruments = 0;
    let offlineInstruments = 0;

    let expectedSamplesTotal = 0;
    let receivedSamplesTotal = 0;
    let anyEligibleChannel = false;

    for (const inst of projInstruments) {
      const instChannels = projChannels.filter(c => c.instrumentId?.toString() === inst._id.toString());
      if (instChannels.length === 0) {
        offlineInstruments++;
        continue;
      }
      
      let instOnline = false;
      const instLatestStates = latestStatesByInst.get(inst._id.toString()) || [];

      for (const ch of instChannels) {
        // Online logic
        const latestStateForCh = instLatestStates
            .filter(ls => ls.parameterCode === ch.parameterCode && ['VALID', 'SUSPECT', 'MANUALLY_VERIFIED'].includes(ls.quality))
            .sort((a, b) => b.observedAt - a.observedAt)[0];
        
        const intervalSec = ch.sampleIntervalSec || 900;

        if (latestStateForCh) {
          const freshLimit = intervalSec * 2 * 1000;
          if ((now.getTime() - new Date(latestStateForCh.observedAt).getTime()) <= freshLimit) {
            instOnline = true;
          }
        }

        // Availability logic
        // 1. commissionedAt, 2. channel.createdAt
        const monitoringStartAt = inst.commissionedAt ? new Date(inst.commissionedAt).getTime() : new Date(ch.createdAt).getTime();
        const effectiveStart = new Date(Math.max(windowStart.getTime(), monitoringStartAt));
        
        if (effectiveStart.getTime() < windowEnd.getTime()) {
          anyEligibleChannel = true;
          
          // Slot coverage
          const effectiveStartMs = effectiveStart.getTime();
          const windowEndMs = windowEnd.getTime();
          const intervalMs = intervalSec * 1000;
          
          const expectedSlots = Math.floor((windowEndMs - effectiveStartMs) / intervalMs);
          
          const chReadings = readingsByChannel.get(ch._id.toString()) || [];
          const coveredSlotIndices = new Set();
          
          for (const reading of chReadings) {
            const sampleTimeMs = new Date(reading.sampleTime).getTime();
            if (sampleTimeMs >= effectiveStartMs && sampleTimeMs <= windowEndMs) {
              const slotIndex = Math.floor((sampleTimeMs - effectiveStartMs) / intervalMs);
              coveredSlotIndices.add(slotIndex);
            }
          }
          
          // Ensure coveredSlots doesn't exceed expectedSlots (in case of boundary logic, though floor naturally bounds it if we cap at expectedSlots)
          const validCoveredSlots = Array.from(coveredSlotIndices).filter(idx => idx >= 0 && idx < expectedSlots).length;
          
          expectedSamplesTotal += expectedSlots;
          receivedSamplesTotal += validCoveredSlots;
        }
      }

      if (instOnline) onlineInstruments++;
      else offlineInstruments++;
    }

    const availPercent = anyEligibleChannel && expectedSamplesTotal > 0 
      ? Math.round((receivedSamplesTotal / expectedSamplesTotal) * 100)
      : null;

    // Last Update At
    const tsList = [
      ...projDecisions.map(d => new Date(d.evaluatedAt).getTime()),
      ...latestStatesByInst.values().flatMap(l => l.map(ls => new Date(ls.observedAt).getTime())),
      ...projDevices.map(d => new Date(d.lastSeenAt || 0).getTime()),
      ...projCameras.map(c => new Date(c.lastImageAt || 0).getTime())
    ].filter(t => t > 0);

    const lastUpdateAt = tsList.length > 0 ? new Date(Math.max(...tsList)).toISOString() : null;

    summaryMap.set(pidStr, {
      operationalStatus,
      counts: {
        instruments: projInstruments.length,
        onlineInstruments,
        offlineInstruments,
        devices: allDevicesCount,
        onlineDevices,
        offlineDevices: Math.max(0, allDevicesCount - onlineDevices),
        gateways,
        cameras: camerasCount,
        openAlarms: projAlarms.length
      },
      availability: {
        percent: availPercent,
        windowHours,
        received: receivedSamplesTotal,
        expected: expectedSamplesTotal
      },
      lastUpdateAt,
      instrumentCount: projInstruments.length, // keep legacy field if used
      deviceCount: allDevicesCount // keep legacy field if used
    });
  }

  return summaryMap;
}
