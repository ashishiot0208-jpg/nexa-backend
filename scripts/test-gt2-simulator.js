/**
 * Comprehensive Test Suite for Phase GT-2: Continuous Realistic Demo Telemetry Simulator
 *
 * Verifies:
 * 1. Config validation (valid, missing deviceCode, duplicate slots, duplicate channels in slot, invalid generator)
 * 2. Packet generation (Generic v1 structure, timestamp updates, sequence increment, unique messageId)
 * 3. Retry preservation (messageId, sequenceNumber, timestamp, readings unchanged)
 * 4. Data generators (stable, gradual_rise, spike, recovery, fixed, range)
 * 5. Multi-slot support & identical channelCode across slots
 * 6. Health generation & omission
 * 7. Real End-to-End HTTP transmission to backend ingest API
 * 8. Backend Commissioning resolution (slot -> instrument -> channelCode -> calibration -> baseline -> LatestState)
 * 9. Severity evaluation & Alarm triggering from simulated packets
 * 10. Idempotency on simulated retries (no duplicate RawReading or Alarm)
 * 11. Controlled demonstration of multi-slot device simulation
 * 12. Guaranteed test fixture cleanup
 */

import http from 'node:http';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { sha256 } from '../src/utils/crypto.js';
import { validateConfig } from './simulator/config.js';
import { ValueGenerator, HealthGenerator } from './simulator/generators.js';
import { SimulatorState } from './simulator/state.js';
import { DeviceSimulator } from './simulator/simulator.js';
import { HttpTransport } from './simulator/transport.js';
import {
  Organization,
  Project,
  Device,
  ProjectGateway,
  DeviceGatewayMapping,
  Instrument,
  SensorDeviceMapping,
  SensorChannel,
  EngineeringSeverityRule,
  AlarmTriggerPolicy,
  Alarm,
  RawReading,
  DerivedReading,
  LatestState,
  DeviceTelemetry
} from '../src/models/index.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
const TEST_PORT = 3097;
const TEST_URL = `http://127.0.0.1:${TEST_PORT}/api/v1/telemetry/ingest`;
const TEST_API_KEY = 'gxn_gt2_simulator_test_key_12345';

let server;
let testOrg;
let testProject;
let testGateway;
let testDevice;
let testInstA;
let testInstB;
let testChannelX;
let testChannelTempA;
let testChannelPore;
let testChannelTempB;
let testRule;
let testPolicy;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

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

async function setupFixtures() {
  console.log('--- Setting up isolated test fixtures ---');

  testOrg = await Organization.create({
    code: 'TEST-ORG-GT2',
    name: 'GT2 Simulator Org',
    status: 'ACTIVE'
  });

  testProject = await Project.create({
    organizationId: testOrg._id,
    code: 'TEST-PRJ-GT2',
    name: 'GT2 Simulator Project',
    status: 'ACTIVE',
    accessMode: 'ROLE_BASED'
  });

  testGateway = await ProjectGateway.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    gatewayId: 'GW-GT2-001',
    name: 'GT2 Test Gateway',
    gateway_uid: 'GWGT2001',
    status: 'COMMISSIONED'
  });

  testDevice = await Device.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceId: 'GT2-DEV-001',
    name: 'GT2 Demo Logger',
    apiKeyHash: sha256(TEST_API_KEY),
    apiKeyPrefix: TEST_API_KEY.slice(0, 10),
    status: 'COMMISSIONED',
    commissioningStatus: 'COMMISSIONED',
    runtimeStatus: 'ONLINE'
  });

  await DeviceGatewayMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevice._id,
    gatewayAssetId: testGateway._id,
    status: 'ACTIVE'
  });

  testInstA = await Instrument.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    code: 'GT2-INC-001',
    name: 'GT2 Inclinometer',
    catalogCode: 'INC',
    status: 'COMMISSIONED'
  });

  testInstB = await Instrument.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    code: 'GT2-PZ-001',
    name: 'GT2 Piezometer',
    catalogCode: 'PZ',
    status: 'COMMISSIONED'
  });

  await SensorDeviceMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevice._id,
    sensorAssetId: testInstA._id,
    connection: { mode: 'slot', slot: 1 },
    status: 'ACTIVE'
  });

  await SensorDeviceMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevice._id,
    sensorAssetId: testInstB._id,
    connection: { mode: 'slot', slot: 2 },
    status: 'ACTIVE'
  });

  // Slot 1 Channels: X_DISP, TEMP
  testChannelX = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstA._id,
    code: 'X_DISP',
    name: 'X Displacement',
    parameterCode: 'DISPLACEMENT_X',
    rawUnit: 'V',
    engineeringUnit: 'mm',
    calibration: { scale: 1.5, offset: 0.5, configured: true },
    baseline: { value: 1.0, configured: true }
  });

  testChannelTempA = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstA._id,
    code: 'TEMP',
    name: 'INC Temperature',
    parameterCode: 'TEMPERATURE',
    rawUnit: 'C',
    engineeringUnit: 'degC',
    calibration: { scale: 1.0, offset: 0.0, configured: true }
  });

  // Slot 2 Channels: PORE_PRESSURE, TEMP (Identical channelCode across slots!)
  testChannelPore = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstB._id,
    code: 'PORE_PRESSURE',
    name: 'Pore Pressure',
    parameterCode: 'PRESSURE',
    rawUnit: 'kPa',
    engineeringUnit: 'kPa',
    calibration: { scale: 2.0, offset: 1.0, configured: true },
    baseline: { value: 5.0, configured: true }
  });

  testChannelTempB = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstB._id,
    code: 'TEMP',
    name: 'PZ Temperature',
    parameterCode: 'TEMPERATURE',
    rawUnit: 'C',
    engineeringUnit: 'degC',
    calibration: { scale: 1.0, offset: 0.0, configured: true }
  });

  // Severity Rule: X_DISP engineeringValue >= 8.0 => S4
  testRule = await EngineeringSeverityRule.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstA._id,
    parameterCode: 'DISPLACEMENT_X',
    code: 'RULE-GT2-X',
    name: 'GT2 X Displacement Rule',
    metric: 'engineeringValue',
    mode: 'INCREASING',
    unit: 'mm',
    thresholds: { s1: 3.0, s2: 5.0, s3: 7.0, s4: 8.0 },
    status: 'ACTIVE'
  });

  // Alarm Policy on Instrument A for S4
  testPolicy = await AlarmTriggerPolicy.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    category: 'ENGINEERING_SEVERITY',
    scope: 'INSTRUMENT',
    instrumentId: testInstA._id,
    parameterCode: 'DISPLACEMENT_X',
    name: 'GT2 Alarm Policy',
    triggerLevels: ['S4'],
    status: 'ACTIVE'
  });

  console.log('--- Fixtures created successfully ---\n');
}

async function cleanupFixtures() {
  console.log('\n--- Cleaning up test fixtures ---');
  if (testOrg) {
    await DeviceTelemetry.deleteMany({ organizationId: testOrg._id });
    await RawReading.deleteMany({ organizationId: testOrg._id });
    await DerivedReading.deleteMany({ organizationId: testOrg._id });
    await LatestState.deleteMany({ organizationId: testOrg._id });
    await Alarm.deleteMany({ organizationId: testOrg._id });
    await EngineeringSeverityRule.deleteMany({ organizationId: testOrg._id });
    await AlarmTriggerPolicy.deleteMany({ organizationId: testOrg._id });
    await SensorChannel.deleteMany({ organizationId: testOrg._id });
    await SensorDeviceMapping.deleteMany({ organizationId: testOrg._id });
    await DeviceGatewayMapping.deleteMany({ organizationId: testOrg._id });
    await Instrument.deleteMany({ organizationId: testOrg._id });
    await Device.deleteMany({ organizationId: testOrg._id });
    await ProjectGateway.deleteMany({ organizationId: testOrg._id });
    await Project.deleteMany({ organizationId: testOrg._id });
    await Organization.deleteMany({ _id: testOrg._id });
  }
  console.log('--- Cleaned up cleanly ---');
}

async function runTests() {
  await mongoose.connect(MONGODB_URI);
  await startServer();

  try {
    await setupFixtures();

    console.log('====================================================');
    console.log('RUNNING GT-2 FIELD SIMULATOR TEST SUITE');
    console.log('====================================================\n');

    // -------------------------------------------------------------
    // SECTION 1: CONFIG VALIDATION TESTS
    // -------------------------------------------------------------
    console.log('--- Section 1: Config Validation ---');

    // 1. Valid config loads
    const validConfig = validateConfig({
      deviceCode: 'DEV-TEST-01',
      intervalMs: 5000,
      slots: [
        { slot: 1, channels: [{ channelCode: 'X_DISP', generator: { type: 'stable', baseline: 1.0 } }] }
      ]
    });
    assert(validConfig.deviceCode === 'DEV-TEST-01' && validConfig.intervalMs === 5000, '1. Valid config loads successfully');

    // 2. Missing deviceCode rejected
    try {
      validateConfig({ slots: [{ slot: 1, channels: [{ channelCode: 'X', generator: { type: 'fixed' } }] }] });
      assert(false, '2. Should reject missing deviceCode');
    } catch (err) {
      assert(err.message.includes('deviceCode is required'), `2. Missing deviceCode rejected: ${err.message}`);
    }

    // 3. Duplicate slot rejected
    try {
      validateConfig({
        deviceCode: 'DEV-TEST-01',
        slots: [
          { slot: 1, channels: [{ channelCode: 'A', generator: { type: 'fixed' } }] },
          { slot: 1, channels: [{ channelCode: 'B', generator: { type: 'fixed' } }] }
        ]
      });
      assert(false, '3. Should reject duplicate slot number');
    } catch (err) {
      assert(err.message.includes('Duplicate slot number'), `3. Duplicate slot rejected: ${err.message}`);
    }

    // 4. Duplicate channelCode in same slot rejected
    try {
      validateConfig({
        deviceCode: 'DEV-TEST-01',
        slots: [
          {
            slot: 1,
            channels: [
              { channelCode: 'TEMP', generator: { type: 'fixed' } },
              { channelCode: 'temp', generator: { type: 'fixed' } }
            ]
          }
        ]
      });
      assert(false, '4. Should reject duplicate channelCode in same slot');
    } catch (err) {
      assert(err.message.includes('Duplicate channelCode'), `4. Duplicate channelCode in slot rejected: ${err.message}`);
    }

    // 5. Invalid generator rejected
    try {
      validateConfig({
        deviceCode: 'DEV-TEST-01',
        slots: [
          { slot: 1, channels: [{ channelCode: 'A', generator: { type: 'nonexistent_generator' } }] }
        ]
      });
      assert(false, '5. Should reject unsupported generator type');
    } catch (err) {
      assert(err.message.includes('Unsupported generator type'), `5. Unsupported generator rejected: ${err.message}`);
    }

    // -------------------------------------------------------------
    // SECTION 2: PACKET GENERATION & RETRY BEHAVIOR
    // -------------------------------------------------------------
    console.log('\n--- Section 2: Packet Generation & Retry Invariants ---');

    const testSim = new DeviceSimulator({
      deviceCode: 'DEV-INVARIANT-01',
      gatewayCode: 'GW-01',
      slots: [
        {
          slot: 1,
          channels: [
            { channelCode: 'X_DISP', generator: { type: 'gradual_rise', initial: 1.0, step: 0.5 } }
          ]
        }
      ]
    }, { initialSeq: 100 });

    // 6. Correct Generic Telemetry v1 packet generated
    const p1 = testSim.generatePacket();
    assert(p1.schemaVersion === 1, '6. Packet has schemaVersion: 1');
    assert(p1.deviceCode === 'DEV-INVARIANT-01', '6. Packet has correct deviceCode');
    assert(p1.gatewayCode === 'GW-01', '6. Packet has gatewayCode');
    assert(Array.isArray(p1.readings) && p1.readings[0].slot === 1, '6. Packet has readings with slot 1');

    // 7. Timestamp changes correctly per new sample
    const p2 = testSim.generatePacket();
    assert(typeof p1.timestamp === 'string' && typeof p2.timestamp === 'string', '7. Timestamps are ISO strings');
    assert(new Date(p2.timestamp).getTime() >= new Date(p1.timestamp).getTime(), '7. Consecutive timestamps advance');

    // 8. sequenceNumber increments
    assert(p1.sequenceNumber === 101, `8. First sequenceNumber is 101 (got ${p1.sequenceNumber})`);
    assert(p2.sequenceNumber === 102, `8. Second sequenceNumber is 102 (got ${p2.sequenceNumber})`);

    // 9. messageId unique between new packets
    assert(p1.messageId !== p2.messageId, `9. New packets have unique messageId (${p1.messageId} !== ${p2.messageId})`);
    assert(p1.messageId.startsWith('DEV-INVARIANT-01-'), '9. messageId follows canonical format');

    // 10-13. Retry Invariants
    console.log('\n--- Retry Invariants ---');
    // Simulate a network failure during transport: transport must retry the EXACT same packet
    const capturedRetries = [];
    let fakeServerCallCount = 0;
    const fakeFailingFetch = async () => {
      fakeServerCallCount++;
      if (fakeServerCallCount < 3) {
        throw new Error('Simulated transient network timeout');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ accepted: true })
      };
    };

    const retryTransport = new HttpTransport({
      targetUrl: 'http://localhost/fake',
      maxRetries: 3,
      retryDelayMs: 20,
      fetchFn: fakeFailingFetch
    });

    const packetToRetry = testSim.generatePacket();
    const res = await retryTransport.send(packetToRetry, {
      onRetry: (evt) => capturedRetries.push(evt)
    });

    assert(res.success === true, '10. Retry succeeded after transient failures');
    assert(res.attempts === 3, `10. Made 3 attempts (got ${res.attempts})`);
    assert(capturedRetries.length === 2, `10. Caught 2 retry events (got ${capturedRetries.length})`);

    // 10. Retry preserves messageId
    assert(capturedRetries.every(r => r.packet.messageId === packetToRetry.messageId), '10. Retry preserves messageId');
    // 11. Retry preserves sequenceNumber
    assert(capturedRetries.every(r => r.packet.sequenceNumber === packetToRetry.sequenceNumber), '11. Retry preserves sequenceNumber');
    // 12. Retry preserves timestamp
    assert(capturedRetries.every(r => r.packet.timestamp === packetToRetry.timestamp), '12. Retry preserves timestamp');
    // 13. Retry preserves values
    assert(capturedRetries.every(r => r.packet.readings[0].channels[0].value === packetToRetry.readings[0].channels[0].value),
      '13. Retry preserves exact sensor values (no regeneration)');

    // -------------------------------------------------------------
    // SECTION 3: DATA GENERATOR TYPES & SCENARIOS
    // -------------------------------------------------------------
    console.log('\n--- Section 3: Data Generator Types & Scenarios ---');

    // 14. Stable generator
    const stableGen = new ValueGenerator({ type: 'stable', baseline: 25.0, noise: 0.1 });
    const sVals = [stableGen.next(), stableGen.next(), stableGen.next()];
    assert(sVals.every(v => Math.abs(v - 25.0) <= 0.15), '14. Stable generator stays centered around baseline');

    // 15. Gradual rise
    const riseGen = new ValueGenerator({ type: 'gradual_rise', initial: 1.0, step: 0.2, max: 10.0, noise: 0 });
    const r1 = riseGen.next();
    const r2 = riseGen.next();
    const r3 = riseGen.next();
    assert(r2 > r1 && r3 > r2, `15. Gradual rise steadily increments values (${r1} -> ${r2} -> ${r3})`);

    // 16. Spike generator
    const spikeGen = new ValueGenerator({ type: 'spike', baseline: 2.0, spikeValue: 50.0, spikeInterval: 4, spikeDuration: 1, noise: 0 });
    const sp1 = spikeGen.next(); // tick 1
    const sp2 = spikeGen.next(); // tick 2
    const sp3 = spikeGen.next(); // tick 3
    const sp4 = spikeGen.next(); // tick 4: 4 % 4 === 0 => SPIKE!
    assert(sp4 === 50.0 && sp1 === 2.0, `16. Spike generator emits spikeValue on schedule (sp4=${sp4}, sp1=${sp1})`);

    // 17. Recovery generator
    const recovGen = new ValueGenerator({ type: 'recovery', initial: 100.0, baseline: 10.0, noise: 0 });
    const rec1 = recovGen.next();
    const rec2 = recovGen.next();
    const rec3 = recovGen.next();
    assert(Math.abs(rec3 - 10.0) < Math.abs(rec1 - 10.0), `17. Recovery generator converges back toward baseline (${rec1} -> ${rec2} -> ${rec3})`);

    // -------------------------------------------------------------
    // SECTION 4: MULTI-SLOT & HEALTH SIMULATION
    // -------------------------------------------------------------
    console.log('\n--- Section 4: Multi-slot & Health Generation ---');

    const multiSim = new DeviceSimulator({
      deviceCode: 'GT2-DEV-001',
      slots: [
        { slot: 1, channels: [{ channelCode: 'TEMP', generator: { type: 'fixed', value: 20.0 } }] },
        { slot: 2, channels: [{ channelCode: 'TEMP', generator: { type: 'fixed', value: 30.0 } }] }
      ]
    });

    const multiPacket = multiSim.generatePacket();
    // 18. Multiple slots generated
    assert(multiPacket.readings.length === 2, `18. Multiple slots generated in one packet (${multiPacket.readings.length} slots)`);
    // 19. Same channelCode on different slots
    assert(multiPacket.readings[0].channels[0].channelCode === 'TEMP' && multiPacket.readings[1].channels[0].channelCode === 'TEMP',
      '19. Same channelCode "TEMP" successfully present across different slots');
    assert(multiPacket.readings[0].channels[0].value === 20.0 && multiPacket.readings[1].channels[0].value === 30.0,
      '19. Multi-slot values preserve independent slot readings');

    // 20. Health payload generated
    const healthGen = new HealthGenerator({ batteryV: 3.92, rssiDbm: -78, network: '4G', internalTempC: 31.5 });
    const h1 = healthGen.next('NORMAL');
    assert(h1 !== null && h1.batteryV === 3.92 && h1.network === '4G', '20. Health payload generated correctly');

    // 21. Health omitted if configured
    const noHealthGen = new HealthGenerator(false);
    assert(noHealthGen.next() === null, '21. Health payload omitted when configured false');

    // -------------------------------------------------------------
    // SECTION 5: REAL END-TO-END HTTP INGESTION & PIPELINE (NO DIRECT DB WRITES)
    // -------------------------------------------------------------
    console.log('\n--- Section 5: Real End-to-End HTTP Telemetry Ingestion ---');

    const liveSim = new DeviceSimulator({
      deviceCode: 'GT2-DEV-001',
      gatewayCode: 'GW-GT2-001',
      targetUrl: TEST_URL,
      apiKey: TEST_API_KEY,
      slots: [
        {
          slot: 1,
          channels: [
            { channelCode: 'X_DISP', generator: { type: 'fixed', value: 3.0 } },
            { channelCode: 'TEMP', generator: { type: 'fixed', value: 25.0 } }
          ]
        },
        {
          slot: 2,
          channels: [
            { channelCode: 'PORE_PRESSURE', generator: { type: 'fixed', value: 20.0 } },
            { channelCode: 'TEMP', generator: { type: 'fixed', value: 24.0 } }
          ]
        }
      ]
    });

    // 22. Simulator posts through real telemetry endpoint over HTTP
    const stepResult = await liveSim.step();
    assert(stepResult.result.success === true, '22. Simulator successfully posted packet over HTTP to backend');
    assert(stepResult.result.status === 200, `22. Ingest API returned HTTP 200 (got ${stepResult.result.status})`);

    // 23. Valid commissioned Device accepted
    assert(stepResult.result.data.accepted === true, '23. Valid commissioned Device accepted by backend');
    assert(stepResult.result.data.device === 'GT2-DEV-001', '23. Backend identified correct deviceCode');

    // 24. Backend Commissioning resolves slots/channels correctly
    assert(stepResult.result.data.resolvedSensors === 2, `24. Resolved 2 instruments via Commissioning slots (got ${stepResult.result.data.resolvedSensors})`);
    assert(stepResult.result.data.processedChannels === 4, `24. Processed 4 channels across the 2 slots (got ${stepResult.result.data.processedChannels})`);

    // 25. Calibration & Baseline still happens in backend
    // For X_DISP: rawValue = 3.0, scale = 1.5, offset = 0.5 => calibrated = 3.0 * 1.5 + 0.5 = 5.0
    // baseline = 1.0 => deltaFromBaseline = 5.0 - 1.0 = 4.0
    const derivedX = await DerivedReading.findOne({
      instrumentId: testInstA._id,
      parameterCode: 'DISPLACEMENT_X'
    }).sort({ observedAt: -1 });

    assert(derivedX !== null, '25. DerivedReading persisted in database by backend ingestion service');
    assert(Math.abs(derivedX.value - 5.0) < 0.001, `25. Backend calculated calibrated value = 5.0 (got ${derivedX.value})`);
    assert(Math.abs(derivedX.deltaFromBaseline - 4.0) < 0.001, `25. Backend calculated baseline delta = 4.0 (got ${derivedX.deltaFromBaseline})`);

    // 26. LatestState updates
    const latestStateX = await LatestState.findOne({
      instrumentId: testInstA._id,
      parameterCode: 'DISPLACEMENT_X'
    });
    assert(latestStateX !== null && Math.abs(latestStateX.value - 5.0) < 0.001,
      `26. LatestState updated to 5.0 (got ${latestStateX?.value})`);

    // 27 & 28. Severity evaluation & Alarm triggering from simulated spike
    console.log('\n--- Severity & Alarm Triggering ---');
    // Switch simulator to SPIKE scenario on X_DISP (raw value 6.0 => calibrated 6.0 * 1.5 + 0.5 = 9.5 >= 8.0 S4 threshold)
    const spikeSim = new DeviceSimulator({
      deviceCode: 'GT2-DEV-001',
      gatewayCode: 'GW-GT2-001',
      targetUrl: TEST_URL,
      apiKey: TEST_API_KEY,
      slots: [
        {
          slot: 1,
          channels: [
            { channelCode: 'X_DISP', generator: { type: 'fixed', value: 6.0 } }
          ]
        }
      ]
    });

    const spikeStep = await spikeSim.step();
    assert(spikeStep.result.success === true, '27. Spike packet accepted over HTTP');

    const derivedSpike = await DerivedReading.findOne({
      instrumentId: testInstA._id,
      parameterCode: 'DISPLACEMENT_X'
    }).sort({ observedAt: -1 });
    assert(derivedSpike.severity?.level === 'S4', `27. Severity evaluated to S4 (got ${derivedSpike.severity?.level})`);

    const alarm = await Alarm.findOne({
      instrumentId: testInstA._id,
      severity: 'S4'
    });
    assert(alarm !== null, '28. Canonical S4 Alarm generated in backend when simulated value crossed threshold');

    // -------------------------------------------------------------
    // SECTION 6: IDEMPOTENCY ON SIMULATED RETRIES
    // -------------------------------------------------------------
    console.log('\n--- Section 6: Idempotency & Duplicate Protection ---');
    // Resend the EXACT same packet as spikeStep
    const rawCountBefore = await RawReading.countDocuments({ messageId: spikeStep.packet.messageId });
    const retryRes = await spikeSim.transport.send(spikeStep.packet);

    assert(retryRes.success === true, '29. Retried duplicate packet returns HTTP 200');
    assert(retryRes.data.duplicate === true, '29. Backend identifies simulated retry as duplicate: true');

    const rawCountAfter = await RawReading.countDocuments({ messageId: spikeStep.packet.messageId });
    assert(rawCountAfter === rawCountBefore, `29. Simulated retry did NOT create duplicate RawReadings (${rawCountAfter} === ${rawCountBefore})`);

    const alarmCount = await Alarm.countDocuments({ instrumentId: testInstA._id, severity: 'S4' });
    assert(alarmCount === 1, `30. Retry did NOT duplicate Alarm (${alarmCount} === 1)`);

    // -------------------------------------------------------------
    // SECTION 7: CONTROLLED DEMONSTRATION TEST (SECTION 30)
    // -------------------------------------------------------------
    console.log('\n--- Section 7: Controlled Demonstration Test (Section 30) ---');
    console.log('Running bounded simulator for 3 packets on demo device GT2-DEV-001...');

    const demoSim = new DeviceSimulator({
      deviceCode: 'GT2-DEV-001',
      gatewayCode: 'GW-GT2-001',
      targetUrl: TEST_URL,
      apiKey: TEST_API_KEY,
      intervalMs: 100, // fast bounded execution
      scenario: 'NORMAL',
      health: {
        batteryV: 3.90,
        rssiDbm: -76,
        network: '4G',
        internalTempC: 30.5
      },
      slots: [
        {
          slot: 1,
          channels: [
            { channelCode: 'X_DISP', generator: { type: 'stable', baseline: 2.0, noise: 0.05 } },
            { channelCode: 'TEMP', generator: { type: 'fixed', value: 26.5 } }
          ]
        },
        {
          slot: 2,
          channels: [
            { channelCode: 'PORE_PRESSURE', generator: { type: 'stable', baseline: 35.0, noise: 0.1 } },
            { channelCode: 'TEMP', generator: { type: 'fixed', value: 23.5 } }
          ]
        }
      ]
    });

    const demoResults = [];
    for (let i = 0; i < 3; i++) {
      const step = await demoSim.step();
      demoResults.push(step);
    }

    assert(demoResults.length === 3, 'Demo sent 3 bounded packets');
    assert(demoResults.every(r => r.result.success === true), 'All 3 demo packets accepted by backend');
    assert(demoResults.every(r => r.result.data.resolvedSensors === 2), 'Each demo packet resolved 2 instruments');
    assert(demoResults.every(r => r.result.data.processedChannels === 4), 'Each demo packet processed 4 channels');

    // Verify Device health was updated
    const updatedDev = await Device.findById(testDevice._id);
    assert(updatedDev.lastBatteryV !== null && updatedDev.lastRssiDbm !== null, 'Device health metrics updated from demo transmissions');

    // Final Check: LAN-PRO-01 accessMode is untouched
    const lanProject = await Project.findOne({ code: 'LAN-PRO-01' });
    if (lanProject) {
      assert(lanProject.accessMode === 'ROLE_BASED', `LAN-PRO-01 accessMode is ROLE_BASED (got: ${lanProject.accessMode})`);
    }

    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================\n');

  } finally {
    await cleanupFixtures();
    await stopServer();
    await mongoose.disconnect();
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});

