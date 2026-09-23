import crypto from 'node:crypto';
import { Alarm, AlarmEvent, DecisionSnapshot, Device, LatestState } from '../models/index.js';
import { confidenceBand, healthRank, maxHealth, severityRank } from '../utils/severity.js';
import { queueAlarmNotifications } from './notification.service.js';

function scoreQuality(readings) {
  if (!readings.length) return 0;
  const score = readings.reduce((s, r) => s + (r.quality === 'VALID' || r.quality === 'MANUALLY_VERIFIED' ? 100 : r.quality === 'SUSPECT' ? 60 : 0), 0) / readings.length;
  return Math.round(score);
}

async function projectHealth(projectId) {
  const devices = await Device.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).lean();
  return maxHealth(devices.map((d) => d.healthGrade || 'H0'));
}

function recommendedActions(severity, health) {
  const actions = [];
  if (severityRank(severity) >= 1) actions.push('ENGINEERING_REVIEW');
  if (severityRank(severity) >= 2) actions.push('ACKNOWLEDGE_ALARM');
  if (severityRank(severity) >= 3) actions.push('EXECUTE_PROJECT_TARP');
  if (severityRank(severity) >= 4) actions.push('URGENT_ENGINEERING_ESCALATION');
  if (healthRank(health) >= 2) actions.push('RESTORE_MONITORING_COVERAGE');
  return actions;
}

async function upsertEngineeringAlarm({ project, instrumentId, decision, emit }) {
  const key = `ENGINEERING:${project._id}:${instrumentId || 'PROJECT'}`;
  let alarm = await Alarm.findOne({ activeKey: key });
  if (severityRank(decision.severity) === 0) {
    if (alarm && !['CONDITION_NORMALIZED', 'CLOSED'].includes(alarm.state)) {
      const from = alarm.state;
      alarm.state = 'CONDITION_NORMALIZED';
      alarm.normalizedAt = new Date();
      alarm.decisionId = decision._id;
      alarm.severity = decision.severity;
      alarm.reasonCodes = decision.reasonCodes;
      await alarm.save();
      await AlarmEvent.create({ alarmId: alarm._id, projectId: project._id, actorType: 'SYSTEM', eventType: 'CONDITION_NORMALIZED', fromState: from, toState: alarm.state });
      await queueAlarmNotifications({ alarm, decision, emit });
    }
    return alarm;
  }
  if (!alarm) {
    alarm = await Alarm.create({
      organizationId: project.organizationId,
      projectId: project._id,
      instrumentId,
      type: 'ENGINEERING',
      title: `${decision.severity} engineering condition`,
      severity: decision.severity,
      state: 'TRIGGERED',
      decisionId: decision._id,
      reasonCodes: decision.reasonCodes,
      acknowledgementDueAt: new Date(Date.now() + (severityRank(decision.severity) >= 3 ? 10 : 60) * 60000),
      activeKey: key
    });
    await AlarmEvent.create({ alarmId: alarm._id, projectId: project._id, actorType: 'SYSTEM', eventType: 'TRIGGERED', toState: 'TRIGGERED', metadata: { decisionId: decision._id } });
  } else {
    const previousSeverity = alarm.severity;
    alarm.severity = decision.severity;
    alarm.decisionId = decision._id;
    alarm.reasonCodes = decision.reasonCodes;
    if (severityRank(decision.severity) > severityRank(previousSeverity) && alarm.state !== 'CLOSED') alarm.state = 'ESCALATED';
    await alarm.save();
    await AlarmEvent.create({ alarmId: alarm._id, projectId: project._id, actorType: 'SYSTEM', eventType: 'UPDATED', fromState: alarm.state, toState: alarm.state, metadata: { previousSeverity, severity: decision.severity } });
  }
  await queueAlarmNotifications({ alarm, decision, emit });
  return alarm;
}

async function upsertHealthAlarm({ project, health, decision, emit }) {
  const key = `HEALTH:${project._id}:PROJECT`;
  let alarm = await Alarm.findOne({ activeKey: key });
  if (healthRank(health) < 2) {
    if (alarm && !['CONDITION_NORMALIZED', 'CLOSED'].includes(alarm.state)) {
      alarm.state = 'CONDITION_NORMALIZED'; alarm.normalizedAt = new Date(); alarm.healthGrade = health; await alarm.save();
      await AlarmEvent.create({ alarmId: alarm._id, projectId: project._id, actorType: 'SYSTEM', eventType: 'CONDITION_NORMALIZED', toState: 'CONDITION_NORMALIZED' });
    }
    return alarm;
  }
  if (!alarm) {
    alarm = await Alarm.create({ organizationId: project.organizationId, projectId: project._id, type: 'MONITORING_HEALTH', title: `${health} monitoring health issue`, healthGrade: health, state: 'TRIGGERED', decisionId: decision._id, reasonCodes: ['MONITORING_HEALTH_DEGRADED'], activeKey: key });
    await AlarmEvent.create({ alarmId: alarm._id, projectId: project._id, actorType: 'SYSTEM', eventType: 'TRIGGERED', toState: 'TRIGGERED' });
  } else { alarm.healthGrade = health; alarm.decisionId = decision._id; await alarm.save(); }
  await queueAlarmNotifications({ alarm, decision, emit });
  return alarm;
}

export async function createDecision({ project, instrumentId, derivedReadings, ruleEvaluation, emit = () => {} }) {
  const health = await projectHealth(project._id);
  const qualityScore = scoreQuality(derivedReadings);
  const availabilityScore = derivedReadings.length ? 100 : 0;
  const corroborationScore = derivedReadings.length >= 2 ? 85 : 70;
  const deviceHealthScore = health === 'H0' ? 100 : health === 'H1' ? 80 : health === 'H2' ? 55 : health === 'H3' ? 25 : 0;
  const calibrationScore = derivedReadings.every((r) => Number(r.calibrationVersion || 1) > 0) ? 100 : 60;
  const confidence = Math.round(0.30 * qualityScore + 0.15 * availabilityScore + 0.25 * corroborationScore + 0.15 * deviceHealthScore + 0.15 * calibrationScore);
  const severityFloor = ruleEvaluation.severityFloor || 'S0';
  const severity = severityFloor; // Correlation/AI may raise later, never lower the deterministic floor.
  const reasons = ruleEvaluation.matchedRules.map((r) => r.reasonCode || r.id);
  if (healthRank(health) >= 1) reasons.push(`MONITORING_${health}`);
  const decisionCode = `DEC-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const decision = await DecisionSnapshot.create({
    decisionCode,
    organizationId: project.organizationId,
    projectId: project._id,
    instrumentId,
    evaluatedAt: new Date(),
    severity,
    severityFloor,
    confidence,
    confidenceBand: confidenceBand(confidence),
    monitoringHealth: health,
    state: severityRank(severity) >= 1 ? 'ALERT' : 'NORMAL',
    reasonCodes: [...new Set(reasons)],
    matchedRules: ruleEvaluation.matchedRules,
    recommendedActions: recommendedActions(severity, health),
    ruleSetId: ruleEvaluation.ruleSet?._id,
    ruleSetVersion: ruleEvaluation.ruleSet?.version,
    inputReadingIds: derivedReadings.map((r) => r._id),
    trace: { qualityScore, availabilityScore, corroborationScore, deviceHealthScore, calibrationScore }
  });

  for (const reading of derivedReadings) {
    await LatestState.findOneAndUpdate(
      { instrumentId: reading.instrumentId, parameterCode: reading.parameterCode },
      { organizationId: reading.organizationId, projectId: reading.projectId, instrumentId: reading.instrumentId, parameterCode: reading.parameterCode, observedAt: reading.observedAt, value: reading.value, unit: reading.unit, quality: reading.quality, ratePerHour: reading.ratePerHour, severity, decisionId: decision._id },
      { upsert: true, new: true }
    );
  }
  await upsertEngineeringAlarm({ project, instrumentId, decision, emit });
  await upsertHealthAlarm({ project, health, decision, emit });
  emit('decision.created', { decisionId: decision._id, decisionCode, projectId: project._id, instrumentId, severity, monitoringHealth: health, confidence, reasonCodes: decision.reasonCodes });
  return decision;
}
