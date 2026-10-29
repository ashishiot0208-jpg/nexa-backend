import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  User,
  Instrument,
  DerivedReading,
  Alarm,
  Investigation,
  Device,
  ProjectGateway,
  EngineeringSeverityRule,
  SensorDeviceMapping,
  DeviceGatewayMapping
} from '../src/models/index.js';
import {
  getProjectMonitoringReport,
  getInstrumentTrendReport,
  getAlarmHistoryReport,
  getInvestigationReport,
  getInvestigationSummaryReport,
  getInfrastructureHealthReport,
  getSeveritySummaryReport,
  getOverallProjectReport
} from '../src/services/report.service.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
const TEST_PORT = 3127;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function assert(condition, message) {
  if (!condition) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(message);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
}

async function runSecurityIsolationSuite() {
  console.log('========================================================');
  console.log('SECURITY REGRESSION TEST: CROSS-ORG REPORT ISOLATION');
  console.log('========================================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('Connected to Primary DB (geonexa)');

  // 0. Pre-test snapshot for immutability verification
  const preSnapshot = {
    projects: await Project.countDocuments(),
    instruments: await Instrument.countDocuments(),
    derivedReadings: await DerivedReading.countDocuments(),
    alarms: await Alarm.countDocuments(),
    investigations: await Investigation.countDocuments(),
    devices: await Device.countDocuments(),
    gateways: await ProjectGateway.countDocuments(),
    severityRules: await EngineeringSeverityRule.countDocuments()
  };

  const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
  assert(Boolean(project), `Found project LAN-PRO-01 (_id: ${project._id})`);

  const projectId = String(project._id);
  const org1Id = String(project.organizationId); // 6ac4cce70f25c8b970d45596 (ORG-1)
  const foreignOrgId = '6ac4c514fb791da169ce9a06'; // GEONEXA-DEMO

  console.log(`\nProject LAN-PRO-01: ${projectId}`);
  console.log(`Authoritative ORG-1: ${org1Id}`);
  console.log(`Foreign Organization: ${foreignOrgId}`);

  // Confirm foreign alarm exists in MongoDB for this projectId (the contamination artifact)
  const foreignAlarm = await Alarm.findOne({ projectId: project._id, organizationId: foreignOrgId }).lean();
  assert(Boolean(foreignAlarm), `Confirmed foreign alarm ALM-783975 exists in DB with orgId=${foreignOrgId}`);

  // Confirm foreign derived readings exist in MongoDB for this projectId
  const foreignReadingsCount = await DerivedReading.countDocuments({ projectId: project._id, organizationId: foreignOrgId });
  assert(foreignReadingsCount > 0, `Confirmed ${foreignReadingsCount} foreign DerivedReadings exist with orgId=${foreignOrgId}`);

  // -------------------------------------------------------------------------
  // 1. Service Level: Alarm History Report Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- 1. Testing Alarm History Report Isolation ---');
  const alarmReport = await getAlarmHistoryReport({
    projectId,
    organizationId: org1Id,
    detailed: true
  });
  assert(alarmReport.data.summary.total === 0, `Alarm History total is 0 (got ${alarmReport.data.summary.total})`);
  assert(alarmReport.data.summary.open === 0, `Alarm History open is 0`);
  assert(alarmReport.data.summary.acknowledged === 0, `Alarm History acknowledged is 0`);
  assert(alarmReport.data.summary.resolved === 0, `Alarm History resolved is 0`);
  assert(alarmReport.data.alarms.length === 0, `Alarm History alarms list is empty`);
  const containsForeignAlarm = alarmReport.data.alarms.some(a => String(a._id) === String(foreignAlarm._id));
  assert(!containsForeignAlarm, 'Foreign alarm ALM-783975 strictly excluded from ORG-1 Alarm History Report');

  // -------------------------------------------------------------------------
  // 2. Service Level: Overall Project Report Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Testing Overall Project Report Isolation ---');
  const overallReport = await getOverallProjectReport({
    projectId,
    organizationId: org1Id,
    options: {
      includeTrendCharts: true,
      includeAlarmDetails: true,
      includeInvestigationDetails: true
    }
  });

  const almSum = overallReport.data.alarmSummary;
  assert(almSum.total === 0, `Overall Report Alarm Summary total is 0 (got ${almSum.total})`);
  assert(almSum.open === 0, `Overall Report Alarm Summary open is 0`);
  assert(almSum.acknowledged === 0, `Overall Report Alarm Summary acknowledged is 0`);
  assert(almSum.resolved === 0, `Overall Report Alarm Summary resolved is 0`);
  assert(almSum.alarms.length === 0, `Overall Report Alarm Summary alarms array is empty`);

  assert(overallReport.data.executiveSummary.alarms.total === 0, `Executive summary alarms total is 0`);
  assert(overallReport.data.appendix.alarmHistory.length === 0, `Appendix alarm history is empty`);
  assert(overallReport.data.operationalAttention.counts.engineeringAttentionCount === 0, `Engineering attention count is 0`);

  const overallLeaked = (overallReport.data.appendix.alarmHistory || []).some(a => String(a._id) === String(foreignAlarm._id)) ||
    (almSum.alarms || []).some(a => String(a._id) === String(foreignAlarm._id));
  assert(!overallLeaked, 'Foreign alarm ALM-783975 strictly excluded from Overall Project Report');

  // -------------------------------------------------------------------------
  // 3. Service Level: Investigation Preservation (Immutable Snapshot)
  // -------------------------------------------------------------------------
  console.log('\n--- 3. Testing Investigation Preservation ---');
  const invSum = overallReport.data.investigationSummary;
  assert(invSum.total === 1, `Investigation Summary total is 1 (got ${invSum.total})`);
  assert(invSum.completed === 1, `Investigation Summary completed is 1`);

  const singleInv = await getInvestigationReport({
    projectId,
    organizationId: org1Id,
    investigationId: 'INV-2026-0010'
  });
  assert(singleInv.data.investigation.code === 'INV-2026-0010', 'Single Investigation INV-2026-0010 retrieved');
  assert(Boolean(singleInv.data.sourceAlarm), 'Investigation sourceAlarm metadata present');
  assert(String(singleInv.data.sourceAlarm.id).endsWith('b4d3f8'), 'Source alarm references historical ALM-B4D3F8');
  assert(singleInv.data.sourceAlarm.status === 'RESOLVED', 'Source alarm status is RESOLVED');

  // -------------------------------------------------------------------------
  // 4. Service Level: Monitoring Summary Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- 4. Testing Monitoring Summary Isolation ---');
  const monReport = await getProjectMonitoringReport({
    projectId,
    organizationId: org1Id
  });
  assert(monReport.data.alarms.total === 0, 'Monitoring Summary alarms total is 0');
  assert(monReport.data.instrumentCoverage.total === 6, 'Monitoring Summary total instruments is 6');

  // -------------------------------------------------------------------------
  // 5. Service Level: Instrument Trend Telemetry Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- 5. Testing Instrument Trend Telemetry Isolation ---');
  const trendReport = await getInstrumentTrendReport({
    projectId,
    organizationId: org1Id,
    instrumentId: 'INC-2026-0001',
    parameterCode: 'x_displacement'
  });
  assert(trendReport.data.instrument.code === 'INC-2026-0001', 'Trend instrument is INC-2026-0001');
  // Foreign derived readings for INC-2026-0001 under GEONEXA-DEMO must NOT appear in ORG-1 trend
  assert(trendReport.data.timeSeries.length === 0, `No foreign telemetry leaked into ORG-1 INC-2026-0001 trend (length: ${trendReport.data.timeSeries.length})`);

  // -------------------------------------------------------------------------
  // 6. Service Level: Infrastructure Health Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- 6. Testing Infrastructure Health Isolation ---');
  const infraReport = await getInfrastructureHealthReport({
    projectId,
    organizationId: org1Id
  });
  assert(infraReport.data.summary.devices.total === 2, 'Infrastructure devices total is 2');
  assert(infraReport.data.summary.gateways.total === 1, 'Infrastructure gateways total is 1');

  // -------------------------------------------------------------------------
  // 7. Service Level: Severity Summary Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- 7. Testing Severity Summary Isolation ---');
  const sevReport = await getSeveritySummaryReport({
    projectId,
    organizationId: org1Id
  });
  assert(sevReport.data.instruments.length === 6, 'Severity instruments count is 6');

  // -------------------------------------------------------------------------
  // 8. HTTP Level Isolation Tests with Authenticated JWT
  // -------------------------------------------------------------------------
  console.log('\n--- 8. Testing HTTP API Endpoints with Authenticated JWT ---');
  const app = createApp();
  let server;
  await new Promise(resolve => {
    server = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });

  try {
    let testUser = await User.findOne({ email: 'admin@geonexa.test' }) || await User.findOne();
    const org1Token = jwt.sign(
      { organizationId: org1Id, organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: testUser._id.toString(), expiresIn: '1h' }
    );
    const org1Headers = { Authorization: `Bearer ${org1Token}` };

    // A. HTTP GET /projects/:projectId/reports/alarms
    const httpAlarmRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/reports/alarms`, { headers: org1Headers });
    assert(httpAlarmRes.status === 200, `HTTP GET reports/alarms returned 200`);
    const httpAlarmData = await httpAlarmRes.json();
    assert(httpAlarmData.data.summary.total === 0, `HTTP reports/alarms returns total 0`);
    assert(httpAlarmData.data.alarms.length === 0, `HTTP reports/alarms returns empty array`);

    // B. HTTP GET /projects/:projectId/reports/overall
    const httpOverallRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/reports/overall`, { headers: org1Headers });
    assert(httpOverallRes.status === 200, `HTTP GET reports/overall returned 200`);
    const httpOverallData = await httpOverallRes.json();
    assert(httpOverallData.data.alarmSummary.total === 0, `HTTP reports/overall alarmSummary.total is 0`);
    assert(httpOverallData.data.alarmSummary.alarms.length === 0, `HTTP reports/overall alarmSummary.alarms is empty`);

    // C. HTTP GET /projects/:projectId/alarms (Canonical Alarms UI)
    const httpCanonicalAlarmsRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/alarms`, { headers: org1Headers });
    assert(httpCanonicalAlarmsRes.status === 200, `HTTP GET /alarms returned 200`);
    const httpCanonicalAlarms = await httpCanonicalAlarmsRes.json();
    assert(Array.isArray(httpCanonicalAlarms) && httpCanonicalAlarms.length === 0, `HTTP canonical alarms returns 0 alarms`);

    // D. HTTP Cross-Org Protection: Foreign Org token accessing LAN-PRO-01
    const foreignToken = jwt.sign(
      { organizationId: foreignOrgId, organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: testUser._id.toString(), expiresIn: '1h' }
    );
    const foreignHeaders = { Authorization: `Bearer ${foreignToken}` };
    const httpCrossOrgRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/reports/overall`, { headers: foreignHeaders });
    assert(httpCrossOrgRes.status === 403 || httpCrossOrgRes.status === 404, `Foreign org accessing LAN-PRO-01 rejected with ${httpCrossOrgRes.status}`);

  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  // -------------------------------------------------------------------------
  // 9. Database Immutability Check
  // -------------------------------------------------------------------------
  console.log('\n--- 9. Verifying Database Immutability ---');
  const postSnapshot = {
    projects: await Project.countDocuments(),
    instruments: await Instrument.countDocuments(),
    derivedReadings: await DerivedReading.countDocuments(),
    alarms: await Alarm.countDocuments(),
    investigations: await Investigation.countDocuments(),
    devices: await Device.countDocuments(),
    gateways: await ProjectGateway.countDocuments(),
    severityRules: await EngineeringSeverityRule.countDocuments()
  };

  assert(JSON.stringify(preSnapshot) === JSON.stringify(postSnapshot), 'Document counts identical before and after test (ZERO MUTATIONS)');
  console.log('\n\x1b[32m[SUCCESS] ALL SECURITY ISOLATION REGRESSION TESTS PASSED!\x1b[0m\n');

  await mongoose.disconnect();
}

runSecurityIsolationSuite().catch(err => {
  console.error('\n\x1b[31m[ERROR]\x1b[0m', err);
  process.exit(1);
});
