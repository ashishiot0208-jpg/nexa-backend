import mongoose from 'mongoose';
import { Instrument, DerivedReading } from '../src/models/index.js';

await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa');

const node = {
  id: 'node_instrument_group_1794548684249',
  type: 'Instrument Group',
  config: {
    groupType: 'MANUAL',
    instrumentIds: ['6ac736b75fed52ab6c39549c', '6ac736b75fed52ab6c39549e'],
    parameterCode: 'x_displacement',
    field: 'deltaFromBaseline'
  }
};

const run = { projectId: new mongoose.Types.ObjectId('6ac64b0f222202652768acaf') };
const startAt = new Date(Date.now() - 30 * 24 * 3600 * 1000);
const endAt = new Date();

console.log('--- EXECUTING INSTRUMENT GROUP BLOCK AS IN runner.js ---');

// EXACT code from runner.js lines 162-216:
function executeInstrumentGroupBlock(node, run, startAt, endAt) {
  const cfg = node.config || {};
  const groupType = cfg.groupType || 'MANUAL';
  const paramCode = cfg.parameterCode;
  const field = cfg.field || 'value';

  const membersData = [];

  const outputData = {
    type: 'GROUP',
    nodeId: node.id,
    groupType,
    parameterCode, // Line 212 of runner.js
    field,
    members: membersData
  };

  return outputData;
}

try {
  executeInstrumentGroupBlock(node, run, startAt, endAt);
} catch (err) {
  console.error('CAPTURED STACK TRACE:');
  console.error(err.stack);
}

await mongoose.disconnect();
