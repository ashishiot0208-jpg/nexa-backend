#!/usr/bin/env node

/**
 * Comprehensive Verification Script for All 9 Correlation Studio Nodes:
 * - DATA: Instrument, Instrument Group, Device
 * - CONTEXT: Gateway, Alarm, Notification
 * - ANALYSIS: Correlation
 * - LOGIC: N-of-M
 * - OUTPUT: Result
 */

import assert from 'node:assert/strict';
import {
  validateGraph,
  alignTimeSeries,
  calculatePearson,
  getRelationshipDescriptor,
  evaluateCorrelation,
  evaluateNofM,
  topologicalSort
} from '../src/services/correlation.service.js';
import { SUPPORTED_NODE_TYPES, isPortConnectionValid } from '../src/services/correlation-engine/validation.js';

console.log('=== STARTING CORRELATION STUDIO 9-NODE VERIFICATION ===\n');

// 1. PALETTE AUDIT (Exact 9 Nodes)
console.log('Step 1: Verifying Palette Node Architecture (9 nodes)...');
const expectedNodes = [
  'Instrument',
  'Instrument Group',
  'Device',
  'Gateway',
  'Alarm',
  'Notification',
  'Correlation',
  'N-of-M',
  'Result'
];

for (const type of expectedNodes) {
  assert.ok(SUPPORTED_NODE_TYPES[type], `Node type '${type}' must be in SUPPORTED_NODE_TYPES`);
}
assert.equal(Object.keys(SUPPORTED_NODE_TYPES).length, 9, 'Exactly 9 node types must be supported');
console.log('✓ Step 1 Passed: Exactly 9 nodes registered in backend engine.');

// 2. CONNECTION COMPATIBILITY RULES
console.log('\nStep 2: Verifying Connection Compatibility Rules...');

// 8 Frozen Allowed connections
assert.equal(isPortConnectionValid('Instrument', 'series', 'Correlation', 'seriesA'), true, 'Instrument -> Correlation (seriesA) must be allowed');
assert.equal(isPortConnectionValid('Instrument', 'series', 'Correlation', 'seriesB'), true, 'Instrument -> Correlation (seriesB) must be allowed');
assert.equal(isPortConnectionValid('Device', 'series', 'Correlation', 'seriesA'), true, 'Device -> Correlation (seriesA) must be allowed');
assert.equal(isPortConnectionValid('Device', 'series', 'Correlation', 'seriesB'), true, 'Device -> Correlation (seriesB) must be allowed');
assert.equal(isPortConnectionValid('Instrument Group', 'group', 'N-of-M', 'groupIn'), true, 'Instrument Group -> N-of-M must be allowed');
assert.equal(isPortConnectionValid('Correlation', 'correlationResult', 'Result', 'correlationIn'), true, 'Correlation -> Result must be allowed');
assert.equal(isPortConnectionValid('N-of-M', 'nofmResult', 'Result', 'nofmIn'), true, 'N-of-M -> Result must be allowed');
assert.equal(isPortConnectionValid('Gateway', 'gatewayContext', 'Result', 'gatewayIn'), true, 'Gateway -> Result must be allowed');
assert.equal(isPortConnectionValid('Alarm', 'alarmContext', 'Result', 'alarmIn'), true, 'Alarm -> Result must be allowed');
assert.equal(isPortConnectionValid('Notification', 'notificationContext', 'Result', 'notificationIn'), true, 'Notification -> Result must be allowed');

// Explicitly Rejected connections
assert.equal(isPortConnectionValid('Instrument', 'series', 'N-of-M', 'groupIn'), false, 'Instrument -> N-of-M must be REJECTED');
assert.equal(isPortConnectionValid('Instrument Group', 'group', 'Correlation', 'seriesA'), false, 'Instrument Group -> Correlation must be REJECTED');
assert.equal(isPortConnectionValid('N-of-M', 'nofmResult', 'Correlation', 'seriesA'), false, 'N-of-M -> Correlation must be REJECTED');
assert.equal(isPortConnectionValid('Device', 'series', 'Result', 'default'), false, 'Device -> Result must be REJECTED');
assert.equal(isPortConnectionValid('Device', 'series', 'Result', 'correlationIn'), false, 'Device -> Result (correlationIn) must be REJECTED');
assert.equal(isPortConnectionValid('Gateway', 'gatewayContext', 'Correlation', 'seriesA'), false, 'Gateway -> Correlation must be REJECTED');
assert.equal(isPortConnectionValid('Gateway', 'gatewayContext', 'N-of-M', 'groupIn'), false, 'Gateway -> N-of-M must be REJECTED');
assert.equal(isPortConnectionValid('Alarm', 'alarmContext', 'Correlation', 'seriesA'), false, 'Alarm -> Correlation must be REJECTED');
assert.equal(isPortConnectionValid('Alarm', 'alarmContext', 'N-of-M', 'groupIn'), false, 'Alarm -> N-of-M must be REJECTED');
assert.equal(isPortConnectionValid('Notification', 'notificationContext', 'Correlation', 'seriesA'), false, 'Notification -> Correlation must be REJECTED');
assert.equal(isPortConnectionValid('Notification', 'notificationContext', 'N-of-M', 'groupIn'), false, 'Notification -> N-of-M must be REJECTED');
assert.equal(isPortConnectionValid('Result', 'default', 'Correlation', 'seriesA'), false, 'Result -> Correlation must be REJECTED');
assert.equal(isPortConnectionValid('Result', 'default', 'Result', 'correlationIn'), false, 'Result -> Result must be REJECTED');
assert.equal(isPortConnectionValid('Result', 'default', 'N-of-M', 'groupIn'), false, 'Result -> N-of-M must be REJECTED');

// Validation rule: Reject 3rd numeric source to Correlation
const threeInputsToCorr = {
  nodes: [
    { id: 'inst1', type: 'Instrument', config: {} },
    { id: 'inst2', type: 'Instrument', config: {} },
    { id: 'dev1', type: 'Device', config: {} },
    { id: 'corr', type: 'Correlation', config: {} },
    { id: 'res', type: 'Result', config: {} }
  ],
  edges: [
    { sourceNodeId: 'inst1', sourcePort: 'series', targetNodeId: 'corr', targetPort: 'seriesA' },
    { sourceNodeId: 'inst2', sourcePort: 'series', targetNodeId: 'corr', targetPort: 'seriesB' },
    { sourceNodeId: 'dev1', sourcePort: 'series', targetNodeId: 'corr', targetPort: 'seriesA' },
    { sourceNodeId: 'corr', sourcePort: 'correlationResult', targetNodeId: 'res', targetPort: 'correlationIn' }
  ]
};
const vThree = validateGraph(threeInputsToCorr);
assert.equal(vThree.valid, false, '3rd numeric input to Correlation must be rejected by validateGraph');
assert.ok(vThree.errors.some(e => e.includes('Correlation') || e.includes('already connected')), 'Error must cite Correlation port / duplicate');

console.log('✓ Step 2 Passed: Connection compatibility matrix strictly verified.');

// 3. DEVICE NUMERIC TIME-SERIES & CORRELATION
console.log('\nStep 3: Verifying Device Telemetry Series Correlation (Battery, RSSI, Temp)...');
{
  const now = Date.now();
  const ONE_HOUR = 3600 * 1000;

  // Instrument time series (e.g. water pressure)
  const instSeries = Array.from({ length: 48 }, (_, i) => ({
    observedAt: new Date(now - (48 - i) * ONE_HOUR),
    value: 10 + i * 0.5 + Math.sin(i / 2) * 2,
    quality: 'VALID'
  }));

  // Device telemetry series 1: Battery Voltage (gradually discharging)
  const batterySeries = Array.from({ length: 48 }, (_, i) => ({
    observedAt: new Date(now - (48 - i) * ONE_HOUR + 5 * 60 * 1000), // 5 min offset
    value: 3.6 - (i * 0.005),
    quality: 'VALID'
  }));

  const corrBattery = evaluateCorrelation({
    seriesA: batterySeries,
    seriesB: instSeries,
    startAt: new Date(now - 48 * ONE_HOUR),
    endAt: new Date(now),
    lagSearch: false,
    minSamples: 10,
    qualityFilter: ['VALID'],
    labelA: 'SNRS485-001 BatteryV',
    labelB: 'Piezometer PZ-01'
  });

  assert.ok(corrBattery.samples >= 40, 'Should align sufficient samples');
  assert.ok(corrBattery.r !== null, 'Pearson r must be calculated');
  console.log(`  Battery Voltage vs Instrument: r = ${corrBattery.r} (${corrBattery.relationship}), samples = ${corrBattery.samples}`);

  // Device telemetry series 2: RSSI (signal strength)
  const rssiSeries = Array.from({ length: 48 }, (_, i) => ({
    observedAt: new Date(now - (48 - i) * ONE_HOUR + 10 * 60 * 1000),
    value: -75 + (i % 5) * 2,
    quality: 'VALID'
  }));

  const corrRssi = evaluateCorrelation({
    seriesA: rssiSeries,
    seriesB: instSeries,
    startAt: new Date(now - 48 * ONE_HOUR),
    endAt: new Date(now),
    lagSearch: true,
    maxLagHours: 12,
    lagStepHours: 1,
    minSamples: 10,
    qualityFilter: ['VALID'],
    labelA: 'SNRS485-001 RSSI',
    labelB: 'Piezometer PZ-01'
  });

  assert.ok(corrRssi.r !== null, 'RSSI Pearson r calculated');
  console.log(`  RSSI vs Instrument (Lag Search): r = ${corrRssi.r}, bestLag = ${corrRssi.bestLagHours}h, semantics = "${corrRssi.lagSemantics}"`);

  // Device telemetry series 3: Internal Temperature (°C)
  const tempSeries = Array.from({ length: 48 }, (_, i) => ({
    observedAt: new Date(now - (48 - i) * ONE_HOUR),
    value: 22 + Math.sin(i * Math.PI / 12) * 8, // diurnal cycle
    quality: 'VALID'
  }));

  const corrTemp = evaluateCorrelation({
    seriesA: tempSeries,
    seriesB: instSeries,
    startAt: new Date(now - 48 * ONE_HOUR),
    endAt: new Date(now),
    lagSearch: false,
    minSamples: 10,
    qualityFilter: ['VALID'],
    labelA: 'SNRS485-001 Temp',
    labelB: 'Piezometer PZ-01'
  });

  assert.ok(corrTemp.r !== null, 'Internal Temp Pearson r calculated');
  console.log(`  Internal Temp vs Instrument: r = ${corrTemp.r} (${corrTemp.relationship})`);
}
console.log('✓ Step 3 Passed: Device numeric telemetry series correlated successfully.');

// 4. TOPOLOGICAL SORT WITH ALL 9 NODES
console.log('\nStep 4: Verifying Topological Execution Order across full 9-node graph...');
{
  const fullGraph = {
    nodes: [
      { id: 'inst1', type: 'Instrument', config: {} },
      { id: 'group1', type: 'Instrument Group', config: {} },
      { id: 'dev1', type: 'Device', config: { metric: 'rssiDbm' } },
      { id: 'gw1', type: 'Gateway', config: {} },
      { id: 'alm1', type: 'Alarm', config: {} },
      { id: 'notif1', type: 'Notification', config: {} },
      { id: 'corr1', type: 'Correlation', config: {} },
      { id: 'nofm1', type: 'N-of-M', config: {} },
      { id: 'res1', type: 'Result', config: {} }
    ],
    edges: [
      { sourceNodeId: 'dev1', sourcePort: 'series', targetNodeId: 'corr1', targetPort: 'seriesA' },
      { sourceNodeId: 'inst1', sourcePort: 'series', targetNodeId: 'corr1', targetPort: 'seriesB' },
      { sourceNodeId: 'group1', sourcePort: 'group', targetNodeId: 'nofm1', targetPort: 'groupIn' },
      { sourceNodeId: 'corr1', sourcePort: 'correlationResult', targetNodeId: 'res1', targetPort: 'correlationIn' },
      { sourceNodeId: 'nofm1', sourcePort: 'nofmResult', targetNodeId: 'res1', targetPort: 'nofmIn' },
      { sourceNodeId: 'gw1', sourcePort: 'gatewayContext', targetNodeId: 'res1', targetPort: 'gatewayIn' },
      { sourceNodeId: 'alm1', sourcePort: 'alarmContext', targetNodeId: 'res1', targetPort: 'alarmIn' },
      { sourceNodeId: 'notif1', sourcePort: 'notificationContext', targetNodeId: 'res1', targetPort: 'notificationIn' }
    ]
  };

  const validation = validateGraph(fullGraph);
  assert.equal(validation.valid, true, `Full graph must be valid: ${validation.errors.join(', ')}`);

  const sorted = topologicalSort(fullGraph.nodes, fullGraph.edges);
  const sortedIds = sorted.map(n => n.id);
  console.log('  Topological Order:', sortedIds.join(' -> '));

  // Assert Result is last
  assert.equal(sortedIds[sortedIds.length - 1], 'res1', 'Result node must be evaluated last');
  // Assert dev1 and inst1 before corr1
  assert.ok(sortedIds.indexOf('dev1') < sortedIds.indexOf('corr1'), 'dev1 before corr1');
  assert.ok(sortedIds.indexOf('inst1') < sortedIds.indexOf('corr1'), 'inst1 before corr1');
  // Assert corr1 before res1
  assert.ok(sortedIds.indexOf('corr1') < sortedIds.indexOf('res1'), 'corr1 before res1');
  // Assert group1 before nofm1
  assert.ok(sortedIds.indexOf('group1') < sortedIds.indexOf('nofm1'), 'group1 before nofm1');
  // Assert nofm1 before res1
  assert.ok(sortedIds.indexOf('nofm1') < sortedIds.indexOf('res1'), 'nofm1 before res1');
  // Assert context nodes before res1
  assert.ok(sortedIds.indexOf('gw1') < sortedIds.indexOf('res1'), 'gw1 before res1');
  assert.ok(sortedIds.indexOf('alm1') < sortedIds.indexOf('res1'), 'alm1 before res1');
  assert.ok(sortedIds.indexOf('notif1') < sortedIds.indexOf('res1'), 'notif1 before res1');
}
console.log('✓ Step 4 Passed: Topological sorting correctly dependencies for all 9 nodes.');

// 5. READ-ONLY DATABASE ISOLATION AUDIT
console.log('\nStep 5: Auditing Database Mutation Protection (Zero operational writes)...');
{
  const runnerPath = new URL('../src/services/correlation-engine/runner.js', import.meta.url);
  import('fs').then(fs => {
    const runnerCode = fs.readFileSync(runnerPath, 'utf8');
    const forbiddenPatterns = [
      /\bDevice\.create\b/,
      /\bDevice\.updateOne\b/,
      /\bDevice\.updateMany\b/,
      /\bDevice\.deleteOne\b/,
      /\bDeviceTelemetry\.create\b/,
      /\bDeviceTelemetry\.updateOne\b/,
      /\bProjectGateway\.create\b/,
      /\bProjectGateway\.updateOne\b/,
      /\bAlarm\.create\b/,
      /\bAlarm\.updateOne\b/,
      /\bAlarm\.updateMany\b/,
      /\bAlarm\.deleteOne\b/,
      /\bNotification\.create\b/,
      /\bNotification\.updateOne\b/,
      /\bNotification\.updateMany\b/,
      /\bNotification\.deleteOne\b/,
      /\bInstrument\.create\b/,
      /\bInstrument\.updateOne\b/,
      /\bDerivedReading\.create\b/,
      /\bDerivedReading\.updateOne\b/
    ];

    for (const pat of forbiddenPatterns) {
      assert.ok(!pat.test(runnerCode), `Runner must not contain operational mutation: ${pat}`);
    }
    console.log('✓ Step 5 Passed: Zero operational write calls in correlation execution runner.');
    console.log('\n======================================================');
    console.log('ALL 9-NODE CORRELATION ENGINE CHECKS PASSED!');
    console.log('======================================================\n');
  });
}
