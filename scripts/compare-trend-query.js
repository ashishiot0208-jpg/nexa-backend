import mongoose from 'mongoose';
import { getInstrumentTrendReport, resolveReportTimeRange } from '../src/services/report.service.js';
import { resolveTelemetryTimeRange } from '../src/routes/telemetry.routes.js';
import { DerivedReading } from '../src/models/index.js';

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/geonexa');
  const db = mongoose.connection.db;

  const projectId = '6ac64b0f222202652768acaf';
  const inst = await db.collection('instruments').findOne({ code: 'INC-2026-0001' });
  const instrumentId = inst._id.toString();

  console.log('Testing with:');
  console.log('projectId:', projectId);
  console.log('instrumentId:', instrumentId, 'code:', inst.code);

  // 1. Working Trends Route Logic (from telemetry.routes.js)
  console.log('\n--- 1. Working Trends Logic ---');
  const trendsQuery = { parameter: 'x_displacement', period: '30d', instrumentId };
  const { from: tFrom, to: tTo } = resolveTelemetryTimeRange(trendsQuery);
  const tTimeQuery = tFrom ? { $gte: tFrom, $lte: tTo } : { $lte: tTo };
  console.log('Trends timeQuery:', { from: tFrom, to: tTo });

  const tMatch = {
    projectId: new mongoose.Types.ObjectId(projectId),
    observedAt: tTimeQuery,
    parameterCode: { $in: ['x_displacement'] },
    instrumentId: new mongoose.Types.ObjectId(instrumentId)
  };
  const tReadings = await DerivedReading.find(tMatch).sort({ observedAt: 1 }).lean();
  console.log('Trends readings count with period=30d:', tReadings.length);

  // What about period=all?
  const trendsQueryAll = { parameter: 'x_displacement', period: 'all', instrumentId };
  const { from: tFromAll, to: tToAll } = resolveTelemetryTimeRange(trendsQueryAll);
  const tTimeQueryAll = tFromAll ? { $gte: tFromAll, $lte: tToAll } : { $lte: tToAll };
  const tMatchAll = {
    projectId: new mongoose.Types.ObjectId(projectId),
    observedAt: tTimeQueryAll,
    parameterCode: { $in: ['x_displacement'] },
    instrumentId: new mongoose.Types.ObjectId(instrumentId)
  };
  const tReadingsAll = await DerivedReading.find(tMatchAll).sort({ observedAt: 1 }).lean();
  console.log('Trends readings count with period=all:', tReadingsAll.length);

  // 2. Report Service Logic (getInstrumentTrendReport)
  console.log('\n--- 2. Report Service Logic ---');
  try {
    const report30d = await getInstrumentTrendReport({
      projectId,
      instrumentId,
      parameterCode: 'x_displacement',
      period: '30d',
      aggregation: 'raw'
    });
    console.log('Report result with period=30d:');
    console.log('  sampleCount:', report30d.data.summary.sampleCount);
    console.log('  readings count:', report30d.data.readings.length);
    console.log('  firstValue:', report30d.data.summary.firstValue);
    console.log('  lastValue:', report30d.data.summary.lastValue);
    console.log('  period in report:', report30d.period);
  } catch (err) {
    console.error('Report 30d failed:', err);
  }

  try {
    const reportAll = await getInstrumentTrendReport({
      projectId,
      instrumentId,
      parameterCode: 'x_displacement',
      period: 'all',
      aggregation: 'raw'
    });
    console.log('Report result with period=all:');
    console.log('  sampleCount:', reportAll.data.summary.sampleCount);
    console.log('  readings count:', reportAll.data.readings.length);
    console.log('  firstValue:', reportAll.data.summary.firstValue);
    console.log('  lastValue:', reportAll.data.summary.lastValue);
  } catch (err) {
    console.error('Report all failed:', err);
  }

  await mongoose.disconnect();
}

main().catch(console.error);
