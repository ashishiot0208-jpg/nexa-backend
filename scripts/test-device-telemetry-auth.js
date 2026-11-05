/**
 * Comprehensive Test Suite for Phase GT-2.1: Device Telemetry Authentication Finalization
 *
 * Verifies all 8 authentication cases and security constraints:
 * 1. Valid key + matching deviceCode -> 200 accepted
 * 2. Missing key header -> 401 Missing x-device-key header
 * 3. Invalid key -> 401 Invalid device credentials
 * 4. Key for DEV-A + packet for DEV-B -> 403 Device credential mismatch (anti-spoofing)
 * 5. Key for DEV-B + packet for DEV-A -> 403 Device credential mismatch
 * 6. Valid key + uncommissioned device -> 400 Device not commissioned
 * 7. Valid key + wrong gateway -> 400 Incompatible Gateway mapping / 404 Unknown Gateway
 * 8. Valid key + unknown slot -> 400 No active SensorDeviceMapping
 * 9. Valid key + unknown channelCode -> 400 Unknown SensorChannel
 * 10. Idempotency on retry with valid key -> 200 duplicate: true
 * 11. Generic payload endpoint /telemetry/ingest-generic with valid key -> 200
 * 12. Generic payload endpoint /telemetry/ingest-generic without key -> 401
 * 13. Generic payload endpoint /telemetry/ingest-generic with mismatched key -> 403
 * 14. Concurrent multi-device ingestion (DEV-A and DEV-B in parallel)
 * 15. LAN-PRO-01 accessMode integrity (strictly ROLE_BASED)
 * 16. Guaranteed cleanup in finally block
 */

import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { sha256 } from '../src/utils/crypto.js';
import { env } from '../src/config/env.js';
import {
  Organization,
  Project,
  Device,
  ProjectGateway,
  DeviceGatewayMapping,
  Instrument,
  SensorDeviceMapping,
  SensorChannel,
  RawReading,
  DerivedReading,
  LatestState
} from '../src/models/index.js';

const TEST_PORT = 3096;
const INGEST_URL = `http://127.0.0.1:${TEST_PORT}/api/v1/telemetry/ingest`;
const GENERIC_INGEST_URL = `http://127.0.0.1:${TEST_PORT}/api/v1/telemetry/ingest-generic`;

let server;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS:\x1b[0m ${message}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✖ FAIL:\x1b[0m ${message}`);
    failed++;
  }
}

// Test fixtures references
let testOrg;
let testProject;
let testGateway;
let testDevA;
let testDevB;
let testDevUncomm;
let testInstA;
let testInstB;
let testChannelA;
let testChannelB;

const KEY_A = 'gxn_gt21_dev_a_secret_key_11111';
const KEY_B = 'gxn_gt21_dev_b_secret_key_22222';
const KEY_UNCOMM = 'gxn_gt21_dev_uncomm_secret_33333';

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
  console.log('--- Setting up isolated GT-2.1 test fixtures ---');

  testOrg = await Organization.create({
    code: 'TEST-ORG-GT21',
    name: 'GT21 Auth Test Org',
    status: 'ACTIVE'
  });

  testProject = await Project.create({
    organizationId: testOrg._id,
    code: 'TEST-PRJ-GT21',
    name: 'GT21 Auth Test Project',
    status: 'ACTIVE',
    accessMode: 'ROLE_BASED'
  });

  testGateway = await ProjectGateway.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    gatewayId: 'GW-GT21-001',
    name: 'GT21 Test Gateway',
    gateway_uid: 'GWGT21001',
    status: 'COMMISSIONED'
  });

  // Device A - Commissioned
  testDevA = await Device.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceId: 'GT21-DEV-A',
    name: 'GT21 Device A',
    apiKeyHash: sha256(KEY_A),
    apiKeyPrefix: KEY_A.slice(0, 10),
    status: 'COMMISSIONED',
    commissioningStatus: 'COMMISSIONED',
    runtimeStatus: 'ONLINE'
  });

  // Device B - Commissioned
  testDevB = await Device.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceId: 'GT21-DEV-B',
    name: 'GT21 Device B',
    apiKeyHash: sha256(KEY_B),
    apiKeyPrefix: KEY_B.slice(0, 10),
    status: 'COMMISSIONED',
    commissioningStatus: 'COMMISSIONED',
    runtimeStatus: 'ONLINE'
  });

  // Device Uncommissioned
  testDevUncomm = await Device.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceId: 'GT21-DEV-UNCOMM',
    name: 'GT21 Uncommissioned Device',
    apiKeyHash: sha256(KEY_UNCOMM),
    apiKeyPrefix: KEY_UNCOMM.slice(0, 10),
    status: 'REGISTERED',
    commissioningStatus: 'REGISTERED',
    runtimeStatus: 'OFFLINE'
  });

  // Device-Gateway Mappings
  await DeviceGatewayMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevA._id,
    gatewayAssetId: testGateway._id,
    status: 'ACTIVE'
  });

  await DeviceGatewayMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevB._id,
    gatewayAssetId: testGateway._id,
    status: 'ACTIVE'
  });

  // Instruments
  testInstA = await Instrument.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    code: 'GT21-INST-001',
    name: 'GT21 Instrument A',
    catalogCode: 'INC',
    status: 'COMMISSIONED'
  });

  testInstB = await Instrument.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    code: 'GT21-INST-002',
    name: 'GT21 Instrument B',
    catalogCode: 'PZ',
    status: 'COMMISSIONED'
  });

  // Sensor-Device Mappings
  await SensorDeviceMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevA._id,
    sensorAssetId: testInstA._id,
    connection: { mode: 'slot', slot: 1 },
    status: 'ACTIVE'
  });

  await SensorDeviceMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevB._id,
    sensorAssetId: testInstB._id,
    connection: { mode: 'slot', slot: 1 },
    status: 'ACTIVE'
  });

  // Sensor Channels
  testChannelA = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstA._id,
    deviceId: testDevA._id,
    code: 'DISP_X',
    parameterCode: 'DISPLACEMENT_X',
    rawUnit: 'mm',
    engineeringUnit: 'mm',
    calibration: { scale: 2.0, offset: 0.0, configured: true, version: 1 },
    baseline: { value: 1.0, configured: true, version: 1 }
  });

  testChannelB = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstB._id,
    deviceId: testDevB._id,
    code: 'PORE_PRESSURE',
    parameterCode: 'PORE_PRESSURE',
    rawUnit: 'kPa',
    engineeringUnit: 'kPa',
    calibration: { scale: 1.0, offset: 0.0, configured: true, version: 1 },
    baseline: { value: 0.0, configured: true, version: 1 }
  });

  console.log('--- Fixtures created successfully ---');
}

async function cleanupFixtures() {
  console.log('--- Cleaning up GT-2.1 test fixtures ---');
  if (testOrg) {
    await RawReading.deleteMany({ deviceId: { $in: [testDevA?._id, testDevB?._id, testDevUncomm?._id] } });
    await DerivedReading.deleteMany({ instrumentId: { $in: [testInstA?._id, testInstB?._id] } });
    await LatestState.deleteMany({ instrumentId: { $in: [testInstA?._id, testInstB?._id] } });
    await SensorChannel.deleteMany({ projectId: testProject?._id });
    await SensorDeviceMapping.deleteMany({ projectId: testProject?._id });
    await DeviceGatewayMapping.deleteMany({ projectId: testProject?._id });
    await Instrument.deleteMany({ projectId: testProject?._id });
    await Device.deleteMany({ projectId: testProject?._id });
    await ProjectGateway.deleteMany({ projectId: testProject?._id });
    await Project.deleteOne({ _id: testProject?._id });
    await Organization.deleteOne({ _id: testOrg?._id });
  }
  console.log('--- Fixtures cleaned up cleanly ---');
}

async function runTests() {
  console.log('====================================================');
  console.log('RUNNING GT-2.1 DEVICE TELEMETRY AUTHENTICATION TESTS');
  console.log('====================================================');

  await mongoose.connect('mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  try {
    await setupFixtures();

    const headerKey = env.deviceKeyHeader;
    console.log(`Configured deviceKeyHeader: '${headerKey}'\n`);

    // -------------------------------------------------------------
    // TEST 1: Valid Key + Matching deviceCode -> HTTP 200
    // -------------------------------------------------------------
    console.log('--- Test 1: Valid Key + Matching deviceCode ---');
    const msgId1 = `gt21-test-1-${Date.now()}`;
    const res1 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_A
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: msgId1,
        sequenceNumber: 101,
        readings: [
          {
            slot: 1,
            channels: [{ channelCode: 'DISP_X', value: 3.5 }]
          }
        ]
      })
    });
    const body1 = await res1.json();
    assert(res1.status === 200, `Valid key + matching deviceCode returns 200 (got ${res1.status})`);
    assert(body1.accepted === true, 'Telemetry accepted: true');
    assert(body1.device === 'GT21-DEV-A', 'Device code matches authenticated device');
    assert(body1.resolvedSensors === 1, 'Resolved 1 sensor via Commissioning slot');
    assert(body1.processedChannels === 1, 'Processed 1 channel');

    // -------------------------------------------------------------
    // TEST 2: Missing Key Header -> HTTP 401
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Missing Key Header ---');
    const res2 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
        // No x-device-key header
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-2-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 3.5 }] }]
      })
    });
    const body2 = await res2.json();
    assert(res2.status === 401, `Missing key header returns 401 (got ${res2.status})`);
    assert(body2.message.includes(`Missing ${headerKey} header`), `Error mentions missing ${headerKey} header: ${body2.message}`);

    // -------------------------------------------------------------
    // TEST 3: Invalid Key -> HTTP 401
    // -------------------------------------------------------------
    console.log('\n--- Test 3: Invalid Key ---');
    const res3 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: 'gxn_bogus_invalid_random_key_99999'
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-3-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 3.5 }] }]
      })
    });
    const body3 = await res3.json();
    assert(res3.status === 401, `Invalid key returns 401 (got ${res3.status})`);
    assert(body3.message.includes('Invalid device credentials'), `Error mentions Invalid device credentials: ${body3.message}`);

    // -------------------------------------------------------------
    // TEST 4: Key for DEV-A + Packet for DEV-B -> HTTP 403 (Anti-Spoofing)
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Key for DEV-A + Packet for DEV-B (Anti-Spoofing) ---');
    const res4 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_A // KEY_A belongs to GT21-DEV-A
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-B', // Packet claims to be GT21-DEV-B
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-4-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'PORE_PRESSURE', value: 20.0 }] }]
      })
    });
    const body4 = await res4.json();
    assert(res4.status === 403, `Device impersonation returns 403 Forbidden (got ${res4.status})`);
    assert(body4.message.includes('Device credential mismatch'), `Error message mentions Device credential mismatch: ${body4.message}`);
    assert(body4.message.includes('GT21-DEV-A') && body4.message.includes('GT21-DEV-B'),
      `Error identifies both authenticated device and claimed device: ${body4.message}`);

    // -------------------------------------------------------------
    // TEST 5: Key for DEV-B + Packet for DEV-A -> HTTP 403
    // -------------------------------------------------------------
    console.log('\n--- Test 5: Key for DEV-B + Packet for DEV-A ---');
    const res5 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_B // KEY_B belongs to GT21-DEV-B
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A', // Packet claims to be GT21-DEV-A
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-5-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 1.0 }] }]
      })
    });
    const body5 = await res5.json();
    assert(res5.status === 403, `Reverse device impersonation returns 403 Forbidden (got ${res5.status})`);
    assert(body5.message.includes('Device credential mismatch'), `Error message mentions Device credential mismatch: ${body5.message}`);

    // -------------------------------------------------------------
    // TEST 6: Valid Key + Uncommissioned Device -> HTTP 400
    // -------------------------------------------------------------
    console.log('\n--- Test 6: Valid Key + Uncommissioned Device ---');
    const res6 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_UNCOMM // Valid key for GT21-DEV-UNCOMM
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-UNCOMM',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-6-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 1.0 }] }]
      })
    });
    const body6 = await res6.json();
    assert(res6.status === 400, `Uncommissioned device rejected with 400 (got ${res6.status})`);
    assert(body6.message.includes('is not commissioned'), `Error message indicates device not commissioned: ${body6.message}`);

    // -------------------------------------------------------------
    // TEST 7: Valid Key + Wrong Gateway -> HTTP 400
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Valid Key + Wrong Gateway ---');
    const tempOtherGw = await ProjectGateway.create({
      organizationId: testOrg._id,
      projectId: testProject._id,
      gatewayId: 'GW-GT21-WRONG',
      name: 'Wrong Temp Gateway',
      gateway_uid: 'GWGT21WRONG',
      status: 'COMMISSIONED'
    });

    const res7 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_A
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-WRONG',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-7-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 1.0 }] }]
      })
    });
    const body7 = await res7.json();
    assert(res7.status === 400, `Incompatible gateway rejected with 400 (got ${res7.status})`);
    assert(body7.message.includes('Incompatible Gateway mapping'), `Error mentions Incompatible Gateway mapping: ${body7.message}`);

    await ProjectGateway.deleteOne({ _id: tempOtherGw._id });

    // -------------------------------------------------------------
    // TEST 8: Valid Key + Unknown Slot -> HTTP 400
    // -------------------------------------------------------------
    console.log('\n--- Test 8: Valid Key + Unknown Slot ---');
    const res8 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_A
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-8-${Date.now()}`,
        readings: [{ slot: 99, channels: [{ channelCode: 'DISP_X', value: 1.0 }] }]
      })
    });
    const body8 = await res8.json();
    assert(res8.status === 400, `Unknown slot rejected with 400 (got ${res8.status})`);
    assert(body8.message.includes('No active SensorDeviceMapping'), `Error mentions No active SensorDeviceMapping: ${body8.message}`);

    // -------------------------------------------------------------
    // TEST 9: Valid Key + Unknown ChannelCode -> HTTP 400
    // -------------------------------------------------------------
    console.log('\n--- Test 9: Valid Key + Unknown ChannelCode ---');
    const res9 = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_A
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-test-9-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'UNKNOWN_CHANNEL', value: 1.0 }] }]
      })
    });
    const body9 = await res9.json();
    assert(res9.status === 400, `Unknown channelCode rejected with 400 (got ${res9.status})`);
    assert(body9.message.includes('Unknown SensorChannel'), `Error mentions Unknown SensorChannel: ${body9.message}`);

    // -------------------------------------------------------------
    // TEST 10: Idempotency with Key on Duplicate Transmission -> HTTP 200
    // -------------------------------------------------------------
    console.log('\n--- Test 10: Idempotency with Device Key ---');
    const dupRes = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_A
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: msgId1, // Same messageId as Test 1
        sequenceNumber: 101,
        readings: [
          {
            slot: 1,
            channels: [{ channelCode: 'DISP_X', value: 3.5 }]
          }
        ]
      })
    });
    const dupBody = await dupRes.json();
    assert(dupRes.status === 200, `Duplicate transmission returns HTTP 200 (got ${dupRes.status})`);
    assert(dupBody.duplicate === true, 'Duplicate flag is true');
    assert(dupBody.storedMeasurements === 0, 'No new measurements stored on duplicate');

    // -------------------------------------------------------------
    // TEST 11: /telemetry/ingest-generic with Valid Key -> HTTP 200
    // -------------------------------------------------------------
    console.log('\n--- Test 11: Generic Ingestion Endpoint with Valid Key ---');
    const genMsgId = `gt21-gen-${Date.now()}`;
    const genRes = await fetch(GENERIC_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_A
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: genMsgId,
        readings: [
          {
            slot: 1,
            channels: [{ channelCode: 'DISP_X', value: 4.0 }]
          }
        ]
      })
    });
    const genBody = await genRes.json();
    assert(genRes.status === 200, `ingest-generic with valid key returns 200 (got ${genRes.status})`);
    assert(genBody.accepted === true, 'Generic packet accepted: true');

    // -------------------------------------------------------------
    // TEST 12: /telemetry/ingest-generic without Key -> HTTP 401
    // -------------------------------------------------------------
    console.log('\n--- Test 12: Generic Ingestion Endpoint without Key ---');
    const genNoKeyRes = await fetch(GENERIC_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A',
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-gen-nokey-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 4.0 }] }]
      })
    });
    assert(genNoKeyRes.status === 401, `ingest-generic without key returns 401 (got ${genNoKeyRes.status})`);

    // -------------------------------------------------------------
    // TEST 13: /telemetry/ingest-generic with Mismatched Key -> HTTP 403
    // -------------------------------------------------------------
    console.log('\n--- Test 13: Generic Ingestion Endpoint with Mismatched Key ---');
    const genMisRes = await fetch(GENERIC_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerKey]: KEY_B // KEY_B for DEV-B
      },
      body: JSON.stringify({
        schemaVersion: 1,
        deviceCode: 'GT21-DEV-A', // Claiming DEV-A
        gatewayCode: 'GW-GT21-001',
        timestamp: new Date().toISOString(),
        messageId: `gt21-gen-mis-${Date.now()}`,
        readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 4.0 }] }]
      })
    });
    assert(genMisRes.status === 403, `ingest-generic with mismatched key returns 403 (got ${genMisRes.status})`);

    // -------------------------------------------------------------
    // TEST 14: Concurrent Multi-Device Ingestion
    // -------------------------------------------------------------
    console.log('\n--- Test 14: Concurrent Multi-Device Ingestion ---');
    const cMsgA = `gt21-conc-a-${Date.now()}`;
    const cMsgB = `gt21-conc-b-${Date.now()}`;

    const [cResA, cResB] = await Promise.all([
      fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [headerKey]: KEY_A },
        body: JSON.stringify({
          schemaVersion: 1,
          deviceCode: 'GT21-DEV-A',
          gatewayCode: 'GW-GT21-001',
          timestamp: new Date().toISOString(),
          messageId: cMsgA,
          readings: [{ slot: 1, channels: [{ channelCode: 'DISP_X', value: 2.5 }] }]
        })
      }),
      fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [headerKey]: KEY_B },
        body: JSON.stringify({
          schemaVersion: 1,
          deviceCode: 'GT21-DEV-B',
          gatewayCode: 'GW-GT21-001',
          timestamp: new Date().toISOString(),
          messageId: cMsgB,
          readings: [{ slot: 1, channels: [{ channelCode: 'PORE_PRESSURE', value: 50.0 }] }]
        })
      })
    ]);

    const [cBodyA, cBodyB] = await Promise.all([cResA.json(), cResB.json()]);
    assert(cResA.status === 200, `Concurrent DEV-A accepted with 200 (got ${cResA.status})`);
    assert(cResB.status === 200, `Concurrent DEV-B accepted with 200 (got ${cResB.status})`);
    assert(cBodyA.device === 'GT21-DEV-A', 'Concurrent packet A assigned to GT21-DEV-A');
    assert(cBodyB.device === 'GT21-DEV-B', 'Concurrent packet B assigned to GT21-DEV-B');

    // -------------------------------------------------------------
    // TEST 15: LAN-PRO-01 Integrity Check
    // -------------------------------------------------------------
    console.log('\n--- Test 15: Project LAN-PRO-01 Integrity Check ---');
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

runTests().catch((err) => {
  console.error('Fatal test error in test-device-telemetry-auth.js:', err);
  process.exit(1);
});

