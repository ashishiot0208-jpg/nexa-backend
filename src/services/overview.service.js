import { Alarm, DecisionSnapshot, Device, Instrument, LatestState, Project } from '../models/index.js';
import { maxHealth } from '../utils/severity.js';
import { deriveOperationalStatus } from './decision-status.service.js';

export async function getProjectOverview(projectId) {
  const project = await Project.findById(projectId).populate('useCaseTemplateId').lean();
  if (!project) return null;
  const [recentDecisions, alarms, instruments, devices, latest] = await Promise.all([
    DecisionSnapshot.find({ projectId }).sort({ evaluatedAt: -1 }).limit(300).lean(),
    Alarm.find({ projectId, state: { $ne: 'CLOSED' } }).sort({ createdAt: -1 }).lean(),
    Instrument.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    Device.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    LatestState.find({ projectId }).sort({ observedAt: -1 }).limit(200).lean()
  ]);

  const latestDecisionByScope = new Map();
  for (const d of recentDecisions) {
    const key = d.instrumentId?.toString() || 'PROJECT';
    if (!latestDecisionByScope.has(key)) latestDecisionByScope.set(key, d);
  }
  const currentDecisions = [...latestDecisionByScope.values()];
  const baseStatus = deriveOperationalStatus(currentDecisions);
  
  // Overview merges device health into the project monitoring health
  const monitoringHealth = maxHealth([...
    currentDecisions.map((d) => d.monitoringHealth),
    ...devices.map((d) => d.healthGrade || 'H0')
  ]);
  const status = { ...baseStatus, monitoringHealth };

  const latestByParam = {};
  for (const x of latest) if (!latestByParam[x.parameterCode]) latestByParam[x.parameterCode] = x;
  return {
    project: { id: project._id, name: project.name, code: project.code, location: project.location, timezone: project.timezone, status: project.status, useCaseCode: project.useCaseCode, useCaseName: project.useCaseTemplateId?.name },
    status,
    counts: { instruments: instruments.length, devices: devices.length, onlineDevices: devices.filter((d) => d.status === 'ONLINE').length, openAlarms: alarms.length },
    latest: Object.values(latestByParam).map((x) => ({ parameterCode: x.parameterCode, value: x.value, unit: x.unit, quality: x.quality, observedAt: x.observedAt, severity: x.severity })),
    alarms: alarms.slice(0, 10).map((a) => ({ id: a._id, type: a.type, title: a.title, severity: a.severity, healthGrade: a.healthGrade, state: a.state, reasonCodes: a.reasonCodes, openedAt: a.openedAt })),
    decision: latestDecisionByScope.size ? currentDecisions.find(d => d._id === baseStatus.decisionId) || null : null
  };
}
