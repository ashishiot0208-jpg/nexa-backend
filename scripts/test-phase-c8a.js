#!/usr/bin/env node

/**
 * PHASE C8A — CANONICAL REPORT DATA FOUNDATION TEST SUITE
 *
 * Verifies all 25 acceptance criteria:
 * 1. Monitoring summary report returns project metadata.
 * 2. Instrument counts correct.
 * 3. Severity summary uses central state.
 * 4. Legacy alarms excluded.
 * 5. Canonical Alarm lifecycle counts correct.
 * 6. Investigation lifecycle counts correct.
 * 7. Instrument trend report returns real persisted telemetry.
 * 8. Trend date filtering works.
 * 9. Trend aggregation reuses existing semantics.
 * 10. Alarm report filters by date.
 * 11. Alarm report filters by status.
 * 12. Alarm report includes immutable lifecycle trace.
 * 13. Investigation detail report includes Alarm snapshot.
 * 14. Investigation findings ordered chronologically.
 * 15. Investigation audit ordered chronologically.
 * 16. Infrastructure report separates commissioning/connectivity.
 * 17. Severity report returns NOT_EVALUATED where no rule.
 * 18. Cross-project access rejected.
 * 19. Viewer read access succeeds.
 * 20. No mutation occurs during report generation.
 * 21. Legacy alarm count unchanged.
 * 22. C7A regression passes.
 * 23. C6 regression passes.
 * 24. C3 severity regression passes.
 * 25. syntax check passes.
 */

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Alarm,
  AlarmEvent,
  Device,
  DerivedReading,
  EngineeringSeverityRule,
  Instrument,
  Investigation,
  InvestigationEvent,
  InvestigationNote,
  LatestState,
  Organization,
  OrganizationMember,
  Project,
  ProjectGateway,
  ProjectMember,
  RawReading,
  SensorChannel,
  User
} from '../src/models/index.js';
import { ensureDevelopmentFixtures } from './seed-development-fixtures.js';

let server;
const TEST_PORT = 3125;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(TEST_PORT, '127.0.0.1', () => {
      resolve();
    });
  });
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(message);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
}

async function runC8aVerification() {
  console.log('====================================================');
  console.log('PHASE C8A — CANONICAL REPORT DATA FOUNDATION TEST');
  console.log('====================================================\n');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  
  // Ensure development fixtures (LAN-PRO-01, INC-2026-0001, ALM-B4D3F8, INV-2026-0001, legacy alarms baseline)
  await ensureDevelopmentFixtures();

  await startServer();

  try {
    // Resolve project LAN-PRO-01
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(Boolean(project), `Resolved project LAN-PRO-01 (${project._id})`);

    const otherProject = await Project.findOne({ _id: { $ne: project._id } });
    assert(Boolean(otherProject), `Resolved secondary project for cross-project isolation (${otherProject._id})`);

    const instrument = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' });
    assert(Boolean(instrument), `Resolved test instrument INC-2026-0001 (${instrument._id})`);

    // Setup Admin and Viewer users & tokens
    let adminUser = await User.findOne({ email: 'admin@geonexa.test' }) || await User.findOne({ email: 'admin@geonexa.local' });
    if (!adminUser) {
      adminUser = await User.create({ email: 'admin@geonexa.test', displayName: 'Test Admin', passwordHash: 'dummy' });
    }
    const adminToken = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: adminUser._id.toString(), expiresIn: '1h' }
    );

    let viewerUser = await User.findOne({ email: 'viewer@geonexa.test' });
    if (!viewerUser) {
      viewerUser = await User.create({ email: 'viewer@geonexa.test', displayName: 'Test Viewer', passwordHash: 'dummy' });
    }
    await OrganizationMember.findOneAndUpdate(
      { organizationId: project.organizationId, userId: viewerUser._id },
      { organizationRole: 'VIEWER', status: 'ACTIVE' },
      { upsert: true }
    );
    await ProjectMember.findOneAndUpdate(
      { projectId: project._id, userId: viewerUser._id },
      { role: 'VIEWER', status: 'ACTIVE' },
      { upsert: true }
    );
    const viewerToken = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'VIEWER' },
      env.jwtSecret,
      { subject: viewerUser._id.toString(), expiresIn: '1h' }
    );

    // Initial snapshot of counts to verify read-only safety (no mutations)
    const initialCounts = {
      alarms: await Alarm.countDocuments(),
      legacyAlarms: await Alarm.countDocuments({ $or: [{ lifecycleVersion: { $ne: 2 } }, { lifecycleVersion: null }] }),
      canonicalAlarms: await Alarm.countDocuments({ lifecycleVersion: 2 }),
      investigations: await Investigation.countDocuments(),
      derivedReadings: await DerivedReading.countDocuments(),
      rawReadings: await RawReading.countDocuments(),
      devices: await Device.countDocuments(),
      instruments: await Instrument.countDocuments()
    };

    console.log(`[INFO] Initial DB counts: alarms=${initialCounts.alarms} (legacy=${initialCounts.legacyAlarms}, canonical=${initialCounts.canonicalAlarms}), invs=${initialCounts.investigations}`);

    // =========================================================================
    // TEST 1, 2, 3, 4, 5, 6: Project Monitoring Summary Report
    // =========================================================================
    console.log('\n--- Test 1-6: Project Monitoring Summary Report ---');
    const monRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/monitoring-summary?period=30d`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(monRes.status === 200, `GET monitoring summary returned HTTP 200 (got: ${monRes.status})`);
    const monReport = await monRes.json();

    // 1. Metadata
    assert(monReport.reportType === 'PROJECT_MONITORING_SUMMARY', `reportType is PROJECT_MONITORING_SUMMARY (got: ${monReport.reportType})`);
    assert(monReport.project?.id === String(project._id), 'project.id matches target project');
    assert(monReport.project?.code === 'LAN-PRO-01', 'project.code is LAN-PRO-01');
    assert(Boolean(monReport.generatedAt), 'generatedAt timestamp exists');
    assert(Boolean(monReport.period?.to), 'period.to exists');
    assert(monReport.data?.project?.name === project.name, `data.project.name is '${project.name}'`);
    assert(Boolean(monReport.data?.project?.site), 'data.project.site is populated');

    // 2. Instrument coverage
    const cov = monReport.data?.instrumentCoverage;
    assert(Boolean(cov), 'instrumentCoverage block exists');
    assert(cov.total >= 1, `total instruments >= 1 (got: ${cov.total})`);
    assert(cov.total === cov.positioned + cov.unpositioned, `total (${cov.total}) === positioned (${cov.positioned}) + unpositioned (${cov.unpositioned})`);
    assert(cov.total === cov.reporting + cov.noTelemetry, `total (${cov.total}) === reporting (${cov.reporting}) + noTelemetry (${cov.noTelemetry})`);
    assert(cov.commissioned >= 1, `commissioned instruments >= 1 (got: ${cov.commissioned})`);

    // 3. Severity summary uses central state
    const sev = monReport.data?.severitySummary;
    assert(Boolean(sev), 'severitySummary block exists');
    assert(typeof sev.S0 === 'number' && typeof sev.S1 === 'number' && typeof sev.S2 === 'number' && typeof sev.S3 === 'number' && typeof sev.S4 === 'number' && typeof sev.NOT_EVALUATED === 'number', 'Severity counts are all numbers');
    const sevSum = sev.S0 + sev.S1 + sev.S2 + sev.S3 + sev.S4 + sev.NOT_EVALUATED;
    assert(sevSum === cov.total, `Severity sum (${sevSum}) equals total instruments (${cov.total})`);

    // 4. Legacy alarms excluded
    const alm = monReport.data?.alarms;
    assert(Boolean(alm), 'alarms block exists');
    assert(initialCounts.legacyAlarms > 0, `Legacy alarms exist in DB (${initialCounts.legacyAlarms})`);
    assert(alm.total < initialCounts.alarms, `Legacy alarms excluded from canonical count (canonical=${alm.total} < totalDB=${initialCounts.alarms})`);

    // 5. Canonical Alarm lifecycle counts
    assert(alm.total === alm.open + alm.acknowledged + alm.resolved, `Canonical alarms total (${alm.total}) === open (${alm.open}) + ack (${alm.acknowledged}) + resolved (${alm.resolved})`);
    assert(alm.resolved >= 1, `Resolved canonical alarm counted (got: ${alm.resolved})`);

    // 6. Investigation lifecycle counts
    const invData = monReport.data?.investigations;
    assert(Boolean(invData), 'investigations block exists');
    assert(invData.total === invData.open + invData.inProgress + invData.completed, `Investigation total (${invData.total}) === open (${invData.open}) + inProgress (${invData.inProgress}) + completed (${invData.completed})`);
    assert(invData.completed >= 1, `Completed investigation counted (got: ${invData.completed})`);

    // =========================================================================
    // TEST 7, 8, 9: Instrument Trend Report
    // =========================================================================
    console.log('\n--- Test 7-9: Instrument Trend Report ---');
    // 7. Persisted telemetry & summary
    const trendRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/instrument-trend?instrumentId=INC-2026-0001&parameterCode=x_displacement&period=90d`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(trendRes.status === 200, `GET instrument trend returned HTTP 200 (got: ${trendRes.status})`);
    const trendReport = await trendRes.json();

    assert(trendReport.reportType === 'INSTRUMENT_TREND_REPORT', `reportType is INSTRUMENT_TREND_REPORT (got: ${trendReport.reportType})`);
    assert(trendReport.data?.instrument?.code === 'INC-2026-0001', 'instrument.code is INC-2026-0001');
    assert(trendReport.data?.measurementContext?.parameter === 'x_displacement', 'parameter is x_displacement');
    assert(trendReport.data?.measurementContext?.baseline?.configured === true, 'baseline is configured');

    const series = trendReport.data?.timeSeries || [];
    assert(series.length >= 3, `Real persisted time-series returned (samples: ${series.length})`);
    for (const point of series) {
      assert(Boolean(point.timestamp), 'Point has timestamp');
      assert(typeof point.value === 'number', `Point has valid numeric value: ${point.value}`);
      assert(Boolean(point.quality), `Point has quality: ${point.quality}`);
    }

    const summ = trendReport.data?.summary;
    assert(Boolean(summ), 'summary statistics block exists');
    assert(typeof summ.firstValue === 'number', `firstValue is numeric: ${summ.firstValue}`);
    assert(typeof summ.lastValue === 'number', `lastValue is numeric: ${summ.lastValue}`);
    assert(typeof summ.min === 'number', `min is numeric: ${summ.min}`);
    assert(typeof summ.max === 'number', `max is numeric: ${summ.max}`);
    assert(typeof summ.avg === 'number', `avg is numeric: ${summ.avg}`);
    assert(typeof summ.change === 'number', `change is numeric: ${summ.change}`);
    assert(Math.abs(summ.change - (summ.lastValue - summ.firstValue)) < 0.001, `change (${summ.change}) === last (${summ.lastValue}) - first (${summ.firstValue})`);

    // 8. Date range filtering & validation
    const fromNarrow = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const toNarrow = new Date().toISOString();
    const narrowRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/instrument-trend?instrumentId=INC-2026-0001&from=${fromNarrow}&to=${toNarrow}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(narrowRes.status === 200, `Narrow date range returned HTTP 200`);
    const narrowReport = await narrowRes.json();
    for (const p of narrowReport.data.timeSeries) {
      const ptTime = new Date(p.timestamp).getTime();
      assert(ptTime >= new Date(fromNarrow).getTime() && ptTime <= new Date(toNarrow).getTime(), `Point time ${p.timestamp} within bounds`);
    }

    // Invalid date range from > to returns 400
    const invDateRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/instrument-trend?instrumentId=INC-2026-0001&from=${toNarrow}&to=${fromNarrow}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(invDateRes.status === 400, `Invalid bounded range (from > to) rejected with HTTP 400 (got: ${invDateRes.status})`);

    // 9. Trend aggregation semantics
    const aggRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/instrument-trend?instrumentId=INC-2026-0001&aggregation=1h&period=90d`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(aggRes.status === 200, `Aggregation 1h returned HTTP 200`);
    const aggReport = await aggRes.json();
    assert(Array.isArray(aggReport.data.timeSeries), 'Aggregated time-series returned');
    if (aggReport.data.timeSeries.length > 0) {
      const firstAgg = aggReport.data.timeSeries[0];
      assert(typeof firstAgg.avg === 'number' || typeof firstAgg.value === 'number', 'Aggregated bucket has average/value');
      assert(typeof firstAgg.min === 'number', 'Aggregated bucket has min');
      assert(typeof firstAgg.max === 'number', 'Aggregated bucket has max');
      assert(typeof firstAgg.count === 'number', 'Aggregated bucket has count');
    }

    // =========================================================================
    // TEST 10, 11, 12: Alarm History Report
    // =========================================================================
    console.log('\n--- Test 10-12: Alarm History Report ---');
    // 10. Filter by date
    const fromAlarmDate = new Date(Date.now() - 60 * 3600 * 1000).toISOString();
    const toAlarmDate = new Date().toISOString();
    const alarmRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/alarms?from=${fromAlarmDate}&to=${toAlarmDate}&detailed=true`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(alarmRes.status === 200, `GET alarms report returned HTTP 200 (got: ${alarmRes.status})`);
    const alarmReport = await alarmRes.json();
    assert(alarmReport.reportType === 'ALARM_HISTORY_REPORT', `reportType is ALARM_HISTORY_REPORT (got: ${alarmReport.reportType})`);
    assert(Array.isArray(alarmReport.data.alarms), 'data.alarms is array');
    assert(alarmReport.data.pagination.total >= 1, `pagination.total >= 1 (got: ${alarmReport.data.pagination.total})`);

    // 11. Filter by status
    const resolvedAlarmRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/alarms?status=RESOLVED`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(resolvedAlarmRes.status === 200, 'GET alarms?status=RESOLVED returned 200');
    const resolvedReport = await resolvedAlarmRes.json();
    for (const a of resolvedReport.data.alarms) {
      assert(a.status === 'RESOLVED', `Filtered alarm status is RESOLVED (got: ${a.status})`);
      assert(a.resolvedAt !== null, 'resolvedAt is populated');
      assert(Boolean(a.resolvedBy), 'resolvedBy is populated');
      assert(Boolean(a.resolutionReason), 'resolutionReason is populated');
    }

    // 12. Immutable lifecycle trace in detailed mode
    const detailedAlarm = alarmReport.data.alarms.find(a => a.status === 'RESOLVED');
    assert(Boolean(detailedAlarm), 'Resolved alarm present in detailed report');
    assert(Array.isArray(detailedAlarm.timeline), 'detailed alarm has timeline array');
    const eventTypes = detailedAlarm.timeline.map(e => e.eventType);
    assert(eventTypes.includes('CREATED'), 'Timeline includes CREATED event');
    assert(eventTypes.includes('ACKNOWLEDGED'), 'Timeline includes ACKNOWLEDGED event');
    assert(eventTypes.includes('RESOLVED'), 'Timeline includes RESOLVED event');
    // Ensure InvestigationEvent is NOT mixed into Alarm timeline
    assert(!eventTypes.includes('FINDING_ADDED'), 'InvestigationEvent (FINDING_ADDED) NOT mixed into Alarm timeline');
    assert(!eventTypes.includes('STARTED'), 'InvestigationEvent (STARTED) NOT mixed into Alarm timeline');

    // =========================================================================
    // TEST 13, 14, 15: Investigation Reports
    // =========================================================================
    console.log('\n--- Test 13-15: Investigation Reports ---');
    // Summary list
    const invListRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/investigations?period=90d`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(invListRes.status === 200, `GET investigations summary returned HTTP 200 (got: ${invListRes.status})`);
    const invListReport = await invListRes.json();
    assert(invListReport.reportType === 'INVESTIGATION_SUMMARY_REPORT', `reportType is INVESTIGATION_SUMMARY_REPORT (got: ${invListReport.reportType})`);
    assert(invListReport.data.investigations.length >= 1, `At least 1 investigation in summary list (got: ${invListReport.data.investigations.length})`);

    const targetInvSummary = invListReport.data.investigations[0];
    const invDetailRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/investigations/${targetInvSummary.investigationCode || targetInvSummary.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(invDetailRes.status === 200, `GET detailed investigation returned HTTP 200 (got: ${invDetailRes.status})`);
    const invDetailReport = await invDetailRes.json();
    assert(invDetailReport.reportType === 'INVESTIGATION_REPORT', `reportType is INVESTIGATION_REPORT (got: ${invDetailReport.reportType})`);

    // 13. Source Alarm snapshot
    const srcAlarm = invDetailReport.data?.sourceAlarm;
    assert(Boolean(srcAlarm), 'sourceAlarm block exists');
    assert(Boolean(srcAlarm.id), 'sourceAlarm.id exists');
    assert(Boolean(srcAlarm.title), 'sourceAlarm.title exists');
    assert(srcAlarm.initialSeverity === 'S1', `sourceAlarm.initialSeverity is S1 (got: ${srcAlarm.initialSeverity})`);
    assert(srcAlarm.highestSeverity === 'S4', `sourceAlarm.highestSeverity is S4 (got: ${srcAlarm.highestSeverity})`);

    // 14. Findings ordered chronologically
    const findings = invDetailReport.data?.findings || [];
    assert(findings.length >= 1, `Findings present (count: ${findings.length})`);
    for (let i = 1; i < findings.length; i++) {
      const prev = new Date(findings[i - 1].createdAt).getTime();
      const curr = new Date(findings[i].createdAt).getTime();
      assert(curr >= prev, `Findings chronologically ordered: ${findings[i].createdAt} >= ${findings[i - 1].createdAt}`);
    }

    // 15. Audit events ordered chronologically
    const auditEvents = invDetailReport.data?.audit || [];
    assert(auditEvents.length >= 3, `Audit events present (count: ${auditEvents.length})`);
    for (let i = 1; i < auditEvents.length; i++) {
      const prev = new Date(auditEvents[i - 1].timestamp).getTime();
      const curr = new Date(auditEvents[i].timestamp).getTime();
      assert(curr >= prev, `Audit events chronologically ordered: ${auditEvents[i].timestamp} >= ${auditEvents[i - 1].timestamp}`);
    }
    const auditTypes = auditEvents.map(e => e.eventType);
    assert(auditTypes[0] === 'CREATED', `First audit event is CREATED (got: ${auditTypes[0]})`);
    assert(auditTypes[auditTypes.length - 1] === 'COMPLETED', `Last audit event is COMPLETED (got: ${auditTypes[auditTypes.length - 1]})`);

    // =========================================================================
    // TEST 16: Infrastructure Health Report
    // =========================================================================
    console.log('\n--- Test 16: Infrastructure Health Report ---');
    const infraRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/infrastructure`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(infraRes.status === 200, `GET infrastructure report returned HTTP 200 (got: ${infraRes.status})`);
    const infraReport = await infraRes.json();
    assert(infraReport.reportType === 'INFRASTRUCTURE_HEALTH_REPORT', `reportType is INFRASTRUCTURE_HEALTH_REPORT (got: ${infraReport.reportType})`);

    const devList = infraReport.data?.devices || [];
    const gwList = infraReport.data?.gateways || [];
    assert(devList.length >= 1, `Devices present in report (count: ${devList.length})`);
    assert(gwList.length >= 1, `Gateways present in report (count: ${gwList.length})`);

    // Commissioning state != runtime connectivity separation
    for (const d of devList) {
      assert(Boolean(d.code), 'Device has code');
      assert(Boolean(d.commissionedStatus), `Device has commissionedStatus (${d.commissionedStatus})`);
      assert(['ONLINE', 'OFFLINE', 'STALE', 'UNKNOWN'].includes(d.runtimeConnectivity), `Device has valid runtimeConnectivity: ${d.runtimeConnectivity}`);
      assert(typeof d.mappedSensorCount === 'number', `Device mappedSensorCount is number: ${d.mappedSensorCount}`);
    }

    for (const g of gwList) {
      assert(Boolean(g.code), 'Gateway has code');
      assert(Boolean(g.commissionedStatus), `Gateway has commissionedStatus (${g.commissionedStatus})`);
      assert(['ONLINE', 'OFFLINE', 'STALE', 'UNKNOWN'].includes(g.runtimeConnectivity), `Gateway has valid runtimeConnectivity: ${g.runtimeConnectivity}`);
      assert(typeof g.mappedDeviceCount === 'number', `Gateway mappedDeviceCount is number: ${g.mappedDeviceCount}`);
    }

    // =========================================================================
    // TEST 17: Severity / Monitoring Summary Report
    // =========================================================================
    console.log('\n--- Test 17: Severity / Monitoring Summary Report ---');
    const sevRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/reports/severity`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(sevRes.status === 200, `GET severity report returned HTTP 200 (got: ${sevRes.status})`);
    const sevReport = await sevRes.json();
    assert(sevReport.reportType === 'SEVERITY_MONITORING_SUMMARY', `reportType is SEVERITY_MONITORING_SUMMARY (got: ${sevReport.reportType})`);

    const instRows = sevReport.data?.instruments || [];
    assert(instRows.length >= 1, `Instrument rows present in report (count: ${instRows.length})`);

    let foundEvaluated = false;
    let foundNotEvaluated = false;
    for (const row of instRows) {
      assert(Boolean(row.instrument?.code), 'Row has instrument code');
      assert(Boolean(row.parameter), 'Row has parameter');
      assert(['S0', 'S1', 'S2', 'S3', 'S4', 'NOT_EVALUATED'].includes(row.currentSeverity), `Row has valid central severity: ${row.currentSeverity}`);
      if (!row.effectiveRule) {
        assert(row.currentSeverity === 'NOT_EVALUATED', `Row without rule evaluated as NOT_EVALUATED (got: ${row.currentSeverity})`);
        foundNotEvaluated = true;
      } else {
        foundEvaluated = true;
      }
    }
    console.log(`[INFO] Severity summary verification: foundEvaluated=${foundEvaluated}, foundNotEvaluated=${foundNotEvaluated}`);

    // =========================================================================
    // TEST 18: Cross-Project Access Rejected
    // =========================================================================
    console.log('\n--- Test 18: Cross-Project Access Rejected ---');
    // Using a user token that has NO access to otherProject
    const unauthRes = await fetch(`${BASE_URL}/api/v1/projects/${otherProject._id}/reports/monitoring-summary`, {
      headers: { Authorization: `Bearer ${viewerToken}` }
    });
    assert(unauthRes.status === 403 || unauthRes.status === 404, `Cross-project report access rejected with 403/404 (got: ${unauthRes.status})`);

    // =========================================================================
    // TEST 19: Viewer Read Access Succeeds
    // =========================================================================
    console.log('\n--- Test 19: Viewer Read Access Succeeds ---');
    const viewerEndpoints = [
      `/api/v1/projects/${project._id}/reports/monitoring-summary`,
      `/api/v1/projects/${project._id}/reports/instrument-trend?instrumentId=INC-2026-0001`,
      `/api/v1/projects/${project._id}/reports/alarms`,
      `/api/v1/projects/${project._id}/reports/investigations`,
      `/api/v1/projects/${project._id}/reports/investigations/${targetInvSummary.investigationCode || targetInvSummary.id}`,
      `/api/v1/projects/${project._id}/reports/infrastructure`,
      `/api/v1/projects/${project._id}/reports/severity`
    ];

    for (const ep of viewerEndpoints) {
      const vRes = await fetch(`${BASE_URL}${ep}`, {
        headers: { Authorization: `Bearer ${viewerToken}` }
      });
      assert(vRes.status === 200, `Viewer read access to ${ep.split('?')[0]} succeeded with HTTP 200 (got: ${vRes.status})`);
    }

    // =========================================================================
    // TEST 20, 21: No Mutation & Legacy Isolation Invariant
    // =========================================================================
    console.log('\n--- Test 20-21: No Mutation & Legacy Invariant ---');
    const finalCounts = {
      alarms: await Alarm.countDocuments(),
      legacyAlarms: await Alarm.countDocuments({ $or: [{ lifecycleVersion: { $ne: 2 } }, { lifecycleVersion: null }] }),
      canonicalAlarms: await Alarm.countDocuments({ lifecycleVersion: 2 }),
      investigations: await Investigation.countDocuments(),
      derivedReadings: await DerivedReading.countDocuments(),
      rawReadings: await RawReading.countDocuments(),
      devices: await Device.countDocuments(),
      instruments: await Instrument.countDocuments()
    };

    assert(finalCounts.alarms === initialCounts.alarms, `Total alarms unchanged (${finalCounts.alarms} === ${initialCounts.alarms})`);
    assert(finalCounts.legacyAlarms === initialCounts.legacyAlarms, `Legacy alarms unchanged (${finalCounts.legacyAlarms} === ${initialCounts.legacyAlarms})`);
    assert(finalCounts.canonicalAlarms === initialCounts.canonicalAlarms, `Canonical alarms unchanged (${finalCounts.canonicalAlarms} === ${initialCounts.canonicalAlarms})`);
    assert(finalCounts.investigations === initialCounts.investigations, `Investigations unchanged (${finalCounts.investigations} === ${initialCounts.investigations})`);
    assert(finalCounts.derivedReadings === initialCounts.derivedReadings, `DerivedReadings unchanged (${finalCounts.derivedReadings} === ${initialCounts.derivedReadings})`);
    assert(finalCounts.rawReadings === initialCounts.rawReadings, `RawReadings unchanged (${finalCounts.rawReadings} === ${initialCounts.rawReadings})`);
    assert(finalCounts.devices === initialCounts.devices, `Devices unchanged (${finalCounts.devices} === ${initialCounts.devices})`);
    assert(finalCounts.instruments === initialCounts.instruments, `Instruments unchanged (${finalCounts.instruments} === ${initialCounts.instruments})`);

    // =========================================================================
    // TEST 22, 23, 24, 25: Regressions & Syntax
    // =========================================================================
    console.log('\n--- Test 22-25: Regressions & Syntax ---');

    // 25. Syntax check
    console.log('[RUN] Running syntax check (scripts/check-syntax.js)...');
    const synRes = spawnSync(process.execPath, ['scripts/check-syntax.js'], { stdio: 'inherit' });
    assert(synRes.status === 0, 'Syntax check passed with exit code 0');

    // 22. C7A regression
    console.log('[RUN] Running C7A regression (scripts/test-phase-c7a.js)...');
    const c7Res = spawnSync(process.execPath, ['scripts/test-phase-c7a.js'], { stdio: 'inherit' });
    assert(c7Res.status === 0, 'C7A regression passed with exit code 0');

    // 23. C6 regressions
    console.log('[RUN] Running C6B regression (scripts/test-phase-c6b.js)...');
    const c6bRes = spawnSync(process.execPath, ['scripts/test-phase-c6b.js'], { stdio: 'inherit' });
    assert(c6bRes.status === 0, 'C6B regression passed with exit code 0');

    console.log('[RUN] Running C6C regression (scripts/test-phase-c6c.js)...');
    const c6cRes = spawnSync(process.execPath, ['scripts/test-phase-c6c.js'], { stdio: 'inherit' });
    assert(c6cRes.status === 0, 'C6C regression passed with exit code 0');

    // 24. C3 regression
    console.log('[RUN] Running C3 regression (scripts/test-phase-c3.js)...');
    const c3Res = spawnSync(process.execPath, ['scripts/test-phase-c3.js'], { stdio: 'inherit' });
    assert(c3Res.status === 0, 'C3 severity regression passed with exit code 0');

    console.log('\n====================================================');
    console.log('ALL 25 PHASE C8A TESTS PASSED SUCCESSFULLY (100%)');
    console.log('====================================================');

  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC8aVerification().catch((err) => {
  console.error('\n[FATAL ERROR]:', err);
  process.exitCode = 1;
});
