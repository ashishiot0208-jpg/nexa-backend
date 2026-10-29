import mongoose from 'mongoose';
import {
  getProjectMonitoringReport,
  getInstrumentTrendReport,
  getAlarmHistoryReport,
  getInvestigationSummaryReport,
  getInvestigationReport,
  getInfrastructureHealthReport,
  getSeveritySummaryReport
} from '../src/services/report.service.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to DB');

  const projectId = '6ac64b0f222202652768acaf'; // LAN-PRO-01
  const instrumentId = '6ac736b75fed52ab6c39549c'; // INC-2026-0001

  console.log('\n--- 1. Testing getProjectMonitoringReport (period: 30d and all) ---');
  try {
    const mon30 = await getProjectMonitoringReport({ projectId, period: '30d' });
    console.log('Monitoring 30d data summary:');
    console.log('  instrumentCoverage:', mon30.data.instrumentCoverage);
    console.log('  severitySummary:', mon30.data.severitySummary);
    console.log('  qualitySummary:', mon30.data.qualitySummary);
    console.log('  alarms:', mon30.data.alarms);
    console.log('  investigations:', mon30.data.investigations);

    const monAll = await getProjectMonitoringReport({ projectId, period: 'all' });
    console.log('Monitoring all period alarms:', monAll.data.alarms);
    console.log('Monitoring all period investigations:', monAll.data.investigations);
  } catch (err) {
    console.error('Monitoring error:', err.message);
  }

  console.log('\n--- 2. Testing getInstrumentTrendReport (period: 30d vs all) ---');
  try {
    const trend30 = await getInstrumentTrendReport({
      projectId,
      instrumentId,
      parameterCode: 'x_displacement',
      period: '30d',
      aggregation: 'raw'
    });
    console.log('Trend 30d:');
    console.log('  timeSeries count:', trend30.data.timeSeries?.length);
    console.log('  summary:', trend30.data.summary);

    const trendAll = await getInstrumentTrendReport({
      projectId,
      instrumentId,
      parameterCode: 'x_displacement',
      period: 'all',
      aggregation: 'raw'
    });
    console.log('Trend all:');
    console.log('  timeSeries count:', trendAll.data.timeSeries?.length);
    console.log('  summary:', trendAll.data.summary);
  } catch (err) {
    console.error('Trend error:', err.message);
  }

  console.log('\n--- 3. Testing getAlarmHistoryReport (period: all) ---');
  try {
    const alarms = await getAlarmHistoryReport({ projectId, period: 'all' });
    console.log('Alarms count:', alarms.data.alarms?.length, 'total:', alarms.data.pagination?.total);
  } catch (err) {
    console.error('Alarms error:', err.message);
  }

  console.log('\n--- 4. Testing getInvestigationSummaryReport (period: all) ---');
  try {
    const invs = await getInvestigationSummaryReport({ projectId, period: 'all' });
    console.log('Investigations count:', invs.data.investigations?.length, 'total:', invs.data.pagination?.total);
    if (invs.data.investigations?.length > 0) {
      console.log('First inv:', invs.data.investigations[0]);
    }
  } catch (err) {
    console.error('Investigations error:', err.message);
  }

  console.log('\n--- 5. Testing getInfrastructureHealthReport ---');
  try {
    const infra = await getInfrastructureHealthReport({ projectId });
    console.log('Infra summary:', infra.data.summary);
    console.log('Devices count:', infra.data.devices?.length);
    console.log('Gateways count:', infra.data.gateways?.length);
  } catch (err) {
    console.error('Infra error:', err.message);
  }

  console.log('\n--- 6. Testing getSeveritySummaryReport ---');
  try {
    const sev = await getSeveritySummaryReport({ projectId });
    console.log('Severity summary:', sev.data.summary);
    console.log('Instruments sample:', sev.data.instruments?.slice(0, 3));
  } catch (err) {
    console.error('Severity error:', err.message);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
