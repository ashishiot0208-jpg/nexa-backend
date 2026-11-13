import mongoose from 'mongoose';
import assert from 'node:assert/strict';
import { CorrelationModel, BacktestRun, Instrument, Device, ProjectGateway } from '../src/models/index.js';
import { executeBacktest } from '../src/services/correlation.service.js';

await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa');

console.log('=== RUNNING ACCEPTANCE TESTS FOR PARAMETER CODE FIX ===\n');

// 1. Test 1: Subgraph: Instrument -> Correlation + Device -> Correlation -> Result
console.log('Test 1: Testing Subgraph (Instrument + Device -> Correlation -> Result)...');

// Find real Instrument & Device
const instDoc = await Instrument.findOne({ code: 'INC-2026-0001' }).lean();
const devDoc = await Device.findOne({ deviceId: 'SNRS485-2026-0001' }).lean();

assert.ok(instDoc, 'Instrument INC-2026-0001 must exist');
assert.ok(devDoc, 'Device SNRS485-2026-0001 must exist');

const testGraph1 = {
  nodes: [
    {
      id: 'node_inst_1',
      type: 'Instrument',
      family: 'DATA',
      title: 'INC-2026-0001',
      position: { x: 50, y: 100 },
      config: {
        instrumentId: String(instDoc._id),
        instrumentCode: 'INC-2026-0001',
        channelCode: 'x_displacement',
        parameterCode: 'x_displacement',
        field: 'value'
      }
    },
    {
      id: 'node_dev_1',
      type: 'Device',
      family: 'DATA',
      title: 'SNRS485-2026-0001',
      position: { x: 50, y: 250 },
      config: {
        deviceId: String(devDoc._id),
        deviceCode: 'SNRS485-2026-0001',
        metric: 'internalTempC'
      }
    },
    {
      id: 'node_corr_1',
      type: 'Correlation',
      family: 'ANALYSIS',
      title: 'Pearson Correlation',
      position: { x: 300, y: 150 },
      config: {
        method: 'PEARSON',
        lagSearch: false,
        maxLagHours: 24,
        lagStepHours: 1,
        minSamples: 20,
        qualityFilter: ['VALID']
      }
    },
    {
      id: 'node_res_1',
      type: 'Result',
      family: 'OUTPUT',
      title: 'Evidence Result',
      position: { x: 550, y: 150 },
      config: {}
    }
  ],
  edges: [
    { id: 'edge_1', sourceNodeId: 'node_inst_1', sourcePort: 'series', targetNodeId: 'node_corr_1', targetPort: 'seriesA' },
    { id: 'edge_2', sourceNodeId: 'node_dev_1', sourcePort: 'series', targetNodeId: 'node_corr_1', targetPort: 'seriesB' },
    { id: 'edge_3', sourceNodeId: 'node_corr_1', sourcePort: 'correlationResult', targetNodeId: 'node_res_1', targetPort: 'correlationIn' }
  ]
};

const model1 = await CorrelationModel.create({
  organizationId: instDoc.organizationId,
  projectId: instDoc.projectId,
  name: 'Test Subgraph Flow 1',
  versions: [{
    version: 1,
    graphJson: testGraph1
  }]
});

const run1 = await BacktestRun.create({
  organizationId: model1.organizationId,
  projectId: model1.projectId,
  modelId: model1._id,
  modelVersion: 1,
  startAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
  endAt: new Date(),
  status: 'QUEUED'
});

await executeBacktest(run1._id);
const finishedRun1 = await BacktestRun.findById(run1._id).lean();

console.log('  Run 1 status:', finishedRun1.status);
console.log('  Run 1 error:', finishedRun1.error || 'None');
assert.notEqual(finishedRun1.error, 'parameterCode is not defined', 'MUST NOT throw parameterCode is not defined');
assert.equal(finishedRun1.status, 'COMPLETED', 'Run 1 must finish with COMPLETED status');
console.log('  ✓ Pearson correlation computed: r =', finishedRun1.metrics?.correlation?.r, 'samples =', finishedRun1.metrics?.correlation?.samples, 'hasEnoughSamples =', finishedRun1.metrics?.correlation?.hasEnoughSamples);
console.log('  ✓ Metric in Device evidence:', finishedRun1.metrics?.device?.metric);

// 2. Test 2: Full 9-Node Graph (Flow 1 from saved models)
console.log('\nTest 2: Testing Full 9-Node Graph (Saved Model "Flow 1")...');
const savedFlow1 = await CorrelationModel.findById('6af5b2da7ee47324b7e1d8e1').lean();
assert.ok(savedFlow1, 'Saved Flow 1 must exist');

const run2 = await BacktestRun.create({
  organizationId: savedFlow1.organizationId,
  projectId: savedFlow1.projectId,
  modelId: savedFlow1._id,
  modelVersion: savedFlow1.versions?.at(-1)?.version || 1,
  startAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
  endAt: new Date(),
  status: 'QUEUED'
});

await executeBacktest(run2._id);
const finishedRun2 = await BacktestRun.findById(run2._id).lean();

console.log('  Run 2 status:', finishedRun2.status);
console.log('  Run 2 error:', finishedRun2.error || 'None');
assert.notEqual(finishedRun2.error, 'parameterCode is not defined', 'MUST NOT throw parameterCode is not defined');
assert.equal(finishedRun2.status, 'COMPLETED', 'Full 9-node graph must finish with COMPLETED status');
console.log('  ✓ Correlation result:', {
  r: finishedRun2.metrics?.correlation?.r,
  relationship: finishedRun2.metrics?.correlation?.relationship,
  samples: finishedRun2.metrics?.correlation?.samples,
  hasEnoughSamples: finishedRun2.metrics?.correlation?.hasEnoughSamples
});
console.log('  ✓ N-of-M result:', {
  parameterCode: finishedRun2.metrics?.nofm?.parameterCode,
  passed: finishedRun2.metrics?.nofm?.passed,
  ratio: finishedRun2.metrics?.nofm?.ratio,
  summary: finishedRun2.metrics?.nofm?.summary
});
console.log('  ✓ Device evidence:', {
  deviceId: finishedRun2.metrics?.device?.deviceId,
  metric: finishedRun2.metrics?.device?.metric,
  unit: finishedRun2.metrics?.device?.unit
});
console.log('  ✓ Gateway evidence:', {
  gatewayId: finishedRun2.metrics?.gateway?.gatewayId,
  status: finishedRun2.metrics?.gateway?.status
});
console.log('  ✓ Alarm evidence:', {
  alarmCount: finishedRun2.metrics?.alarm?.alarmCount,
  highestSeverity: finishedRun2.metrics?.alarm?.highestSeverity
});
console.log('  ✓ Notification evidence:', {
  notificationCount: finishedRun2.metrics?.notification?.notificationCount
});

// Clean up temporary test model
await CorrelationModel.deleteOne({ _id: model1._id });
await BacktestRun.deleteMany({ _id: { $in: [run1._id, run2._id] } });

console.log('\n======================================================');
console.log('ALL PARAMETER CODE FIX TESTS PASSED SUCCESSFULLY!');
console.log('======================================================');

await mongoose.disconnect();
