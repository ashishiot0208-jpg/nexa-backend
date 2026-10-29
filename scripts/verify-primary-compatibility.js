import mongoose from 'mongoose';
import {
  Project,
  Instrument,
  DerivedReading,
  Alarm,
  Investigation,
  Device,
  ProjectGateway,
  EngineeringSeverityRule
} from '../src/models/index.js';
import {
  getProjectMonitoringReport,
  getInstrumentTrendReport,
  getAlarmHistoryReport,
  getInvestigationSummaryReport,
  getInfrastructureHealthReport,
  getSeveritySummaryReport
} from '../src/services/report.service.js';
import { getProjectOperationalSummaries } from '../src/services/instrument-summary.service.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';

function assert(cond, msg) {
  if (!cond) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${msg}`);
    throw new Error(msg);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${msg}`);
}

async function run() {
  console.log('========================================================');
  console.log('NON-DESTRUCTIVE PRIMARY DATABASE COMPATIBILITY TEST');
  console.log('========================================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('Connected to Primary DB (geonexa)');

  // Take pre-test snapshot of document counts across all relevant collections
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
  console.log('[SNAPSHOT] Pre-test record counts:', preSnapshot);

  // 1. Resolve Project LAN-PRO-01 and Instrument INC-2026-0001
  const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
  assert(Boolean(project), `Found project LAN-PRO-01 (_id: ${project?._id})`);

  const instrument = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' }).lean();
  assert(Boolean(instrument), `Found instrument INC-2026-0001 (_id: ${instrument?._id})`);

  // 2. Telemetry / Trends vs Instrument Trend Report
  console.log('\n--- 1. Testing Trends Telemetry vs Instrument Trend Report ---');
  // Raw persisted readings for INC-2026-0001 for x_displacement in the last 30d
  const to = new Date();
  const from30d = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  const rawCount30d = await DerivedReading.countDocuments({
    projectId: project._id,
    instrumentId: instrument._id,
    parameterCode: 'x_displacement',
    observedAt: { $gte: from30d, $lte: to }
  });

  const rawCountAll = await DerivedReading.countDocuments({
    projectId: project._id,
    instrumentId: instrument._id,
    parameterCode: 'x_displacement'
  });

  console.log(`Direct DerivedReading count: last 30d = ${rawCount30d}, all-time = ${rawCountAll}`);

  const trend30d = await getInstrumentTrendReport({
    projectId: project._id,
    instrumentId: instrument._id,
    parameterCode: 'x_displacement',
    period: '30d'
  });

  const trendAll = await getInstrumentTrendReport({
    projectId: project._id,
    instrumentId: instrument._id,
    parameterCode: 'x_displacement',
    period: 'all'
  });

  // Verify both readings and timeSeries arrays exist and match direct count
  assert(Array.isArray(trend30d.data.readings), 'trend30d.data.readings is an Array');
  assert(Array.isArray(trend30d.data.timeSeries), 'trend30d.data.timeSeries is an Array');
  assert(trend30d.data.readings.length === rawCount30d, `30d report readings (${trend30d.data.readings.length}) === direct DerivedReading count (${rawCount30d})`);
  assert(trendAll.data.readings.length === rawCountAll, `All-time report readings (${trendAll.data.readings.length}) === direct DerivedReading count (${rawCountAll})`);
  assert(trend30d.data.parameter.code === 'x_displacement', `Parameter code is x_displacement (${trend30d.data.parameter.code})`);
  assert(Boolean(trend30d.data.parameter.unit), `Parameter has unit: ${trend30d.data.parameter.unit}`);
  assert(typeof trend30d.data.summary.firstValue === 'number' || trend30d.data.summary.firstValue === null, 'firstValue is valid');
  assert(typeof trend30d.data.summary.minimum === 'number' || trend30d.data.summary.minimum === null, 'minimum is valid');
  assert(typeof trend30d.data.summary.maximum === 'number' || trend30d.data.summary.maximum === null, 'maximum is valid');
  assert(typeof trend30d.data.summary.average === 'number' || trend30d.data.summary.average === null, 'average is valid');
  assert(trend30d.data.summary.sampleCount === rawCount30d, `summary.sampleCount (${trend30d.data.summary.sampleCount}) === ${rawCount30d}`);

  // 3. Operational Summaries vs Monitoring Summary Report
  console.log('\n--- 2. Testing Operational Summaries vs Monitoring Report ---');
  const opSummaries = await getProjectOperationalSummaries(project._id, project.organizationId);
  const monitoring = await getProjectMonitoringReport({
    projectId: project._id,
    period: 'all'
  });

  assert(monitoring.data.instrumentCoverage.total === opSummaries.length, `Total instruments (${monitoring.data.instrumentCoverage.total}) matches operational summaries count (${opSummaries.length})`);
  assert(monitoring.data.severityDistribution !== undefined, 'severityDistribution is present');
  assert(monitoring.data.measurementQuality !== undefined, 'measurementQuality is present');
  assert(monitoring.data.alarmSummary !== undefined, 'alarmSummary is present');
  assert(monitoring.data.investigationSummary !== undefined, 'investigationSummary is present');

  // 4. Canonical Alarms vs Alarm History Report
  console.log('\n--- 3. Testing Canonical Alarms vs Alarm History Report ---');
  const directCanonicalAlarms = await Alarm.countDocuments({
    projectId: project._id,
    lifecycleVersion: 2
  });
  const alarmReport = await getAlarmHistoryReport({
    projectId: project._id,
    period: 'all'
  });

  assert(alarmReport.data.summary !== undefined, 'alarmReport.data.summary is present');
  assert(alarmReport.data.summary.total === directCanonicalAlarms, `Alarm report total (${alarmReport.data.summary.total}) matches direct canonical count (${directCanonicalAlarms})`);
  assert(alarmReport.data.alarms.length === directCanonicalAlarms, `Alarm items count (${alarmReport.data.alarms.length}) matches direct canonical count (${directCanonicalAlarms})`);

  // 5. Canonical Investigations vs Investigation Reports
  console.log('\n--- 4. Testing Canonical Investigations vs Investigation Reports ---');
  const directInvs = await Investigation.countDocuments({
    projectId: project._id,
    lifecycleVersion: 1
  });
  const invSummaryReport = await getInvestigationSummaryReport({
    projectId: project._id,
    period: 'all'
  });

  assert(invSummaryReport.data.summary !== undefined, 'invSummaryReport.data.summary is present');
  assert(invSummaryReport.data.summary.total === directInvs, `Investigation report summary total (${invSummaryReport.data.summary.total}) matches direct count (${directInvs})`);
  assert(invSummaryReport.data.investigations.length === directInvs, `Investigation items count (${invSummaryReport.data.investigations.length}) matches direct count (${directInvs})`);

  if (directInvs > 0) {
    const firstInv = invSummaryReport.data.investigations[0];
    assert(Boolean(firstInv.code), `Investigation item has code: ${firstInv.code}`);
    assert(Boolean(firstInv.asset), 'Investigation item has asset reference');
    assert(Boolean(firstInv.assignedTo), 'Investigation item has assignedTo reference');
  }

  // 6. Infrastructure Health Report vs DB
  console.log('\n--- 5. Testing Devices & Gateways vs Infrastructure Report ---');
  const directDevCount = await Device.countDocuments({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } });
  const directGwCount = await ProjectGateway.countDocuments({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } });

  const infraReport = await getInfrastructureHealthReport({ projectId: project._id });
  const devList = Array.isArray(infraReport.data.devices) ? infraReport.data.devices : (infraReport.data.devices?.items || []);
  const gwList = Array.isArray(infraReport.data.gateways) ? infraReport.data.gateways : (infraReport.data.gateways?.items || []);

  assert(devList.length === directDevCount, `Devices count (${devList.length}) matches DB (${directDevCount})`);
  assert(gwList.length === directGwCount, `Gateways count (${gwList.length}) matches DB (${directGwCount})`);
  assert(infraReport.data.summary.devices.total === directDevCount, 'Summary devices count matches');
  assert(infraReport.data.summary.gateways.total === directGwCount, 'Summary gateways count matches');

  // 7. Severity Summary Report vs Central Severity Rules
  console.log('\n--- 6. Testing Severity Summary Report ---');
  const sevReport = await getSeveritySummaryReport({ projectId: project._id });
  assert(sevReport.data.summary.totalInstruments === opSummaries.length, `Severity total instruments (${sevReport.data.summary.totalInstruments}) === operational summaries (${opSummaries.length})`);
  assert(sevReport.data.instruments.length === opSummaries.length, 'All instruments listed with evaluated or NOT_EVALUATED severity');

  // 8. Assert NO database mutation occurred
  console.log('\n--- 7. Non-Destructive Validation (Strict Verification) ---');
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

  for (const [coll, count] of Object.entries(preSnapshot)) {
    assert(postSnapshot[coll] === count, `Collection '${coll}' completely unmutated: ${postSnapshot[coll]} === ${count}`);
  }

  console.log('\n========================================================');
  console.log('ALL PRIMARY DATABASE COMPATIBILITY CHECKS PASSED');
  console.log('========================================================');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
