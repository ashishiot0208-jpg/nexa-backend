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
import { getOverallProjectReport } from '../src/services/report.service.js';
import { generateReportPdf } from '../src/services/report-export.service.js';

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
  console.log('PHASE C8C: OVERALL PROJECT REPORT VERIFICATION');
  console.log('========================================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('Connected to Primary DB (geonexa)');

  // 1. Take pre-test snapshot
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

  // 2. Fetch project LAN-PRO-01
  const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
  assert(Boolean(project), `Found project LAN-PRO-01 (_id: ${project?._id})`);

  // 3. Test getOverallProjectReport
  console.log('\n--- 1. Testing getOverallProjectReport ---');
  const overallReport = await getOverallProjectReport({
    projectId: project._id,
    period: '30d',
    options: {
      includeTrendCharts: true,
      includeAlarmDetails: true,
      includeInvestigationDetails: true
    },
    user: { displayName: 'Lead Engineer', email: 'engineer@geonexa.io', role: 'ENGINEER' }
  });

  assert(overallReport.reportType === 'OVERALL_PROJECT_MONITORING', `Report type is OVERALL_PROJECT_MONITORING`);
  assert(overallReport.project?.code === 'LAN-PRO-01', `Project code is LAN-PRO-01`);
  assert(Boolean(overallReport.generatedAt), `Generated timestamp exists`);
  assert(overallReport.options?.includeTrendCharts === true, `includeTrendCharts is true`);

  const data = overallReport.data;
  assert(Boolean(data), 'Report data payload exists');

  // Section 1: Project Information
  console.log('\n--- Section 1: Project Information ---');
  assert(data.projectInformation?.name === project.name, `Project name matches: ${data.projectInformation?.name}`);
  assert(data.projectInformation?.code === 'LAN-PRO-01', `Project code matches: LAN-PRO-01`);
  assert(Boolean(data.projectInformation?.reportPeriod), `Report period metadata present`);

  // Section 2: Executive Monitoring Summary
  console.log('\n--- Section 2: Executive Monitoring Summary ---');
  const exec = data.executiveSummary;
  assert(Boolean(exec?.instrumentCoverage), 'Instrument coverage present');
  assert(exec.instrumentCoverage.total === 6, `Total instruments is 6 (${exec.instrumentCoverage.total})`);
  assert(exec.instrumentCoverage.commissioned >= 0, `Commissioned count: ${exec.instrumentCoverage.commissioned}`);
  assert(Boolean(exec?.severityDistribution), 'Severity distribution present');
  assert(Boolean(exec?.measurementQuality), 'Measurement quality present');
  assert(Boolean(exec?.infrastructure), 'Infrastructure summary present');
  assert(exec.infrastructure.devices?.total === 2, `Devices total is 2 (${exec.infrastructure.devices?.total})`);
  assert(exec.infrastructure.gateways?.total === 1, `Gateways total is 1 (${exec.infrastructure.gateways?.total})`);
  assert(Boolean(exec?.alarmSummary), 'Alarm summary present');
  assert(Boolean(exec?.investigationSummary), 'Investigation summary present');

  // Section 3: Current Instrument Status
  console.log('\n--- Section 3: Current Instrument Status ---');
  const currStatus = data.currentInstrumentStatus;
  assert(currStatus.disclaimer === 'Latest reading available at report generation time.', 'Disclaimer matches exact specification');
  assert(currStatus.totalInstruments === 6, `Current instruments count is 6 (${currStatus.totalInstruments})`);
  assert(currStatus.instruments.length === 6, 'All 6 instruments returned');
  
  // Verify multi-channel representation
  const multiChannelInst = currStatus.instruments.find(i => i.channels && i.channels.length > 1);
  assert(Boolean(multiChannelInst), `Found multi-channel instrument: ${multiChannelInst?.instrument?.code} (${multiChannelInst?.channels?.length} channels)`);
  const firstChannel = multiChannelInst?.channels?.[0];
  assert(Boolean(firstChannel?.parameterCode), `Channel has parameterCode: ${firstChannel?.parameterCode}`);
  assert(firstChannel?.latestValue !== undefined, `Channel has latestValue`);
  assert(Boolean(firstChannel?.freshness), `Channel has freshness state: ${firstChannel?.freshness}`);

  // Section 4: Trend Summary
  console.log('\n--- Section 4: Trend Summary ---');
  const trend = data.trendSummary;
  assert(Array.isArray(trend.items), 'Trend items is an array');
  console.log(`Trend items count: ${trend.items.length}`);
  if (trend.items.length > 0) {
    const firstTrend = trend.items[0];
    assert(Boolean(firstTrend.instrumentCode), `Trend item has instrumentCode: ${firstTrend.instrumentCode}`);
    assert(typeof firstTrend.firstValue === 'number', `firstValue is numeric: ${firstTrend.firstValue}`);
    assert(typeof firstTrend.lastValue === 'number', `lastValue is numeric: ${firstTrend.lastValue}`);
    assert(typeof firstTrend.minimum === 'number', `minimum is numeric: ${firstTrend.minimum}`);
    assert(typeof firstTrend.maximum === 'number', `maximum is numeric: ${firstTrend.maximum}`);
    assert(typeof firstTrend.average === 'number', `average is numeric: ${firstTrend.average}`);
    assert(typeof firstTrend.change === 'number', `change is numeric: ${firstTrend.change}`);
    assert(firstTrend.sampleCount > 0, `sampleCount is > 0 (${firstTrend.sampleCount})`);
  }

  // Section 5: Engineering Severity Summary
  console.log('\n--- Section 5: Engineering Severity Summary ---');
  const sevSum = data.severitySummary;
  assert(Boolean(sevSum?.summary?.severityDistribution), 'Severity summary distribution present');
  assert(Array.isArray(sevSum.instruments), 'Severity instruments is an array');
  assert(sevSum.instruments.length === 6, `Severity instruments length is 6`);

  // Section 6: Alarm Summary
  console.log('\n--- Section 6: Alarm Summary ---');
  const alm = data.alarmSummary;
  assert(typeof alm.total === 'number', `Alarm total is numeric: ${alm.total}`);
  assert(Array.isArray(alm.alarms), 'Alarms list is an array');
  console.log(`Canonical alarms in period: ${alm.total}`);

  // Section 7: Investigation Summary
  console.log('\n--- Section 7: Investigation Summary ---');
  const inv = data.investigationSummary;
  assert(typeof inv.total === 'number', `Investigation total is numeric: ${inv.total}`);
  assert(Array.isArray(inv.investigations), 'Investigations list is an array');
  assert(inv.total >= 1, `Found canonical investigation (${inv.total})`);

  // Section 8: Infrastructure Health
  console.log('\n--- Section 8: Infrastructure Health ---');
  const infraHealth = data.infrastructureHealth;
  assert(Boolean(infraHealth.devices), 'Devices summary present');
  assert(Boolean(infraHealth.gateways), 'Gateways summary present');
  assert(infraHealth.devices.summary?.total === 2, `Devices total matches 2`);
  assert(infraHealth.gateways.summary?.total === 1, `Gateways total matches 1`);

  // Section 9: Operational Attention
  console.log('\n--- Section 9: Operational Attention ---');
  const att = data.operationalAttention;
  assert(Boolean(att?.counts), 'Operational attention counts present');
  assert(typeof att.counts.totalAttentionItems === 'number', `totalAttentionItems is numeric: ${att.counts.totalAttentionItems}`);
  assert(Boolean(att.categories?.engineeringAttention), 'Engineering attention category present');
  assert(Boolean(att.categories?.monitoringGaps), 'Monitoring gaps category present');
  assert(Boolean(att.categories?.infrastructureAttention), 'Infrastructure attention category present');
  assert(Boolean(att.categories?.workflowAttention), 'Workflow attention category present');
  console.log('Operational attention counts:', att.counts);

  // Section 10: Appendix
  console.log('\n--- Section 10: Appendix ---');
  const appx = data.appendix;
  assert(Boolean(appx?.measurementSummary), 'Appendix measurement summary present');
  assert(Boolean(appx?.trendStatistics), 'Appendix trend statistics present');
  assert(Boolean(appx?.alarmHistory), 'Appendix alarm history present');
  assert(Boolean(appx?.investigationList), 'Appendix investigation list present');
  assert(Boolean(appx?.infrastructureInventory), 'Appendix infrastructure inventory present');

  // 4. Test PDF Export
  console.log('\n--- 4. Testing PDF Export ---');
  const pdfBuffer = await generateReportPdf('OVERALL_PROJECT_MONITORING', overallReport);
  assert(Buffer.isBuffer(pdfBuffer), 'PDF result is a Buffer');
  assert(pdfBuffer.length > 5000, `PDF buffer length is valid: ${pdfBuffer.length} bytes`);
  const pdfHeader = pdfBuffer.slice(0, 5).toString('ascii');
  assert(pdfHeader === '%PDF-', `PDF starts with standard %PDF- header (${pdfHeader})`);

  // 5. Verify snapshot count after test: ZERO DB MUTATIONS
  console.log('\n--- 5. Verifying DB Immutability ---');
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

  assert(JSON.stringify(preSnapshot) === JSON.stringify(postSnapshot), 'Document counts identical before and after (NO DB MUTATIONS)');
  console.log('\n\x1b[32m[SUCCESS] ALL C8C BACKEND & PDF VERIFICATIONS PASSED!\x1b[0m\n');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('\n\x1b[31m[ERROR]\x1b[0m', err);
  process.exit(1);
});
