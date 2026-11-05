/**
 * Verification Test Suite: Channel Code Case Policy & RawReading Index Migration
 *
 * Verifies:
 * 1. TEMP channel can be created.
 * 2. temp on same instrument is rejected as duplicate.
 * 3. Temp on same instrument is rejected as duplicate.
 * 4. Same code on a different instrument remains allowed.
 * 5. Generic telemetry with TEMP, temp, or Temp resolves according to the official case-insensitive policy.
 * 6. Legacy telemetry remains working.
 * 7. Fresh database/index state results in correct new unique index.
 * 8. Existing old index can be migrated safely.
 * 9. Re-running migration does nothing harmful.
 * 10. Same messageId + TEMP across Slot 1 Instrument A and Slot 2 Instrument B can persist correctly.
 * 11. Exact duplicate packet still deduplicates correctly.
 */

import mongoose from 'mongoose';
import { ingestTelemetry } from '../src/services/telemetry.service.js';
import { migrateRawReadingIndex, ensureIndexesMigrated } from '../src/config/index-migration.js';
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

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';

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

let testOrg;
let testProject;
let testGateway;
let testDevice;
let testInstA;
let testInstB;

async function setup() {
  console.log('--- Setting up test fixtures ---');
  testOrg = await Organization.create({
    code: 'TEST-ORG-CASE',
    name: 'Case Test Org',
    status: 'ACTIVE'
  });

  testProject = await Project.create({
    organizationId: testOrg._id,
    code: 'TEST-PRJ-CASE',
    name: 'Case Test Project',
    status: 'ACTIVE',
    accessMode: 'ROLE_BASED'
  });

  testGateway = await ProjectGateway.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    gatewayId: 'GW-CASE-01',
    name: 'Case Gateway',
    gateway_uid: 'GWCASE01',
    status: 'COMMISSIONED'
  });

  testDevice = await Device.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceId: 'DEV-CASE-01',
    name: 'Case Logger',
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
    code: 'INST-CASE-A',
    name: 'Instrument A',
    catalogCode: 'TH',
    status: 'COMMISSIONED'
  });

  testInstB = await Instrument.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    code: 'INST-CASE-B',
    name: 'Instrument B',
    catalogCode: 'TH',
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

  console.log('--- Setup complete ---\n');
}

async function cleanup() {
  console.log('\n--- Cleaning up test fixtures ---');
  if (testOrg) {
    await RawReading.deleteMany({ organizationId: testOrg._id });
    await DerivedReading.deleteMany({ organizationId: testOrg._id });
    await LatestState.deleteMany({ organizationId: testOrg._id });
    await SensorChannel.deleteMany({ organizationId: testOrg._id });
    await SensorDeviceMapping.deleteMany({ organizationId: testOrg._id });
    await DeviceGatewayMapping.deleteMany({ organizationId: testOrg._id });
    await Instrument.deleteMany({ organizationId: testOrg._id });
    await Device.deleteMany({ organizationId: testOrg._id });
    await ProjectGateway.deleteMany({ organizationId: testOrg._id });
    await Project.deleteMany({ organizationId: testOrg._id });
    await Organization.deleteMany({ _id: testOrg._id });
  }
  console.log('--- Cleanup finished ---');
}

async function runTests() {
  await mongoose.connect(MONGODB_URI);

  try {
    await setup();

    console.log('=== PART 1: CHANNEL CODE CASE POLICY TESTS ===\n');

    // 1. TEMP channel can be created
    console.log('Test 1: Create TEMP channel on Instrument A');
    const chA = await SensorChannel.create({
      organizationId: testOrg._id,
      projectId: testProject._id,
      instrumentId: testInstA._id,
      code: 'TEMP',
      name: 'Temperature',
      parameterCode: 'TEMPERATURE',
      rawUnit: 'C',
      engineeringUnit: 'degC',
      calibration: { scale: 1.0, offset: 0.0, configured: true }
    });
    assert(chA !== null && chA.code === 'TEMP', 'TEMP channel successfully created with exact casing preserved');

    // 2. temp on same instrument is rejected as duplicate
    console.log('\nTest 2: Reject lowercase "temp" on same Instrument A');
    try {
      await SensorChannel.create({
        organizationId: testOrg._id,
        projectId: testProject._id,
        instrumentId: testInstA._id,
        code: 'temp',
        name: 'Lower Temp',
        parameterCode: 'TEMPERATURE',
        rawUnit: 'C',
        engineeringUnit: 'degC'
      });
      assert(false, 'Should have rejected lowercase temp as duplicate');
    } catch (err) {
      assert(err.message.includes('Duplicate channel code') || err.message.includes('duplicate key'),
        `Lowercase temp safely rejected: ${err.message}`);
    }

    // 3. Temp on same instrument is rejected as duplicate
    console.log('\nTest 3: Reject mixed-case "Temp" on same Instrument A');
    try {
      await SensorChannel.create({
        organizationId: testOrg._id,
        projectId: testProject._id,
        instrumentId: testInstA._id,
        code: 'Temp',
        name: 'Title Case Temp',
        parameterCode: 'TEMPERATURE',
        rawUnit: 'C',
        engineeringUnit: 'degC'
      });
      assert(false, 'Should have rejected mixed-case Temp as duplicate');
    } catch (err) {
      assert(err.message.includes('Duplicate channel code') || err.message.includes('duplicate key'),
        `Mixed-case Temp safely rejected: ${err.message}`);
    }

    // 4. Same code on a different instrument remains allowed
    console.log('\nTest 4: Same code "TEMP" on different Instrument B remains allowed');
    const chB = await SensorChannel.create({
      organizationId: testOrg._id,
      projectId: testProject._id,
      instrumentId: testInstB._id,
      code: 'TEMP',
      name: 'Inst B Temp',
      parameterCode: 'TEMPERATURE',
      rawUnit: 'C',
      engineeringUnit: 'degC',
      calibration: { scale: 1.0, offset: 0.0, configured: true }
    });
    assert(chB !== null && chB.code === 'TEMP', 'Same code TEMP allowed on separate instrument B');

    // 5. Generic telemetry with TEMP, temp, or Temp resolves according to official case-insensitive policy
    console.log('\nTest 5: Generic telemetry resolution across case variants (TEMP, temp, Temp)');
    const t1 = await ingestTelemetry({
      schemaVersion: 1,
      deviceCode: 'DEV-CASE-01',
      gatewayCode: 'GW-CASE-01',
      timestamp: '2026-11-05T12:00:00+05:30',
      messageId: 'M-CASE-001',
      readings: [{ slot: 1, channels: [{ channelCode: 'TEMP', value: 21.5 }] }]
    });
    assert(t1.accepted === true, 'Telemetry with exact match "TEMP" accepted');

    const t2 = await ingestTelemetry({
      schemaVersion: 1,
      deviceCode: 'DEV-CASE-01',
      gatewayCode: 'GW-CASE-01',
      timestamp: '2026-11-05T12:05:00+05:30',
      messageId: 'M-CASE-002',
      readings: [{ slot: 1, channels: [{ channelCode: 'temp', value: 22.0 }] }]
    });
    assert(t2.accepted === true, 'Telemetry with lowercase "temp" accepted and resolved to channel');

    const t3 = await ingestTelemetry({
      schemaVersion: 1,
      deviceCode: 'DEV-CASE-01',
      gatewayCode: 'GW-CASE-01',
      timestamp: '2026-11-05T12:10:00+05:30',
      messageId: 'M-CASE-003',
      readings: [{ slot: 1, channels: [{ channelCode: 'Temp', value: 22.5 }] }]
    });
    assert(t3.accepted === true, 'Telemetry with title case "Temp" accepted and resolved to channel');

    const latestState = await LatestState.findOne({ instrumentId: testInstA._id, parameterCode: 'TEMPERATURE' });
    assert(latestState !== null && Math.abs(latestState.value - 22.5) < 0.001,
      `LatestState updated to 22.5 from case-insensitive "Temp" (got: ${latestState?.value})`);

    // 6. Legacy telemetry remains working
    console.log('\nTest 6: Legacy telemetry with case variants');
    const leg1 = await ingestTelemetry({
      deviceCode: 'DEV-CASE-01',
      gatewayCode: 'GW-CASE-01',
      timestamp: '2026-11-05T12:15:00+05:30',
      messageId: 'M-CASE-LEG-001',
      readings: [{ slot: 1, values: { temp: 23.0 } }]
    });
    assert(leg1.accepted === true, 'Legacy telemetry with values map { temp: 23.0 } processed');

    console.log('\n=== PART 2: RAWREADING INDEX DEPLOYMENT TESTS ===\n');

    // 7. Fresh database/index state results in correct new unique index
    console.log('Test 7: Verify target unique index exists on rawreadings');
    const rawIndexes = await RawReading.collection.indexes();
    const hasTargetIndex = rawIndexes.some(idx =>
      idx.name === 'deviceId_1_messageId_1_instrumentId_1_channelCode_1' ||
      (idx.key && idx.key.deviceId === 1 && idx.key.messageId === 1 && idx.key.instrumentId === 1 && idx.key.channelCode === 1)
    );
    const hasOldIndex = rawIndexes.some(idx =>
      idx.name === 'deviceId_1_messageId_1_channelCode_1' ||
      (idx.key && idx.key.deviceId === 1 && idx.key.messageId === 1 && idx.key.channelCode === 1 && !idx.key.instrumentId)
    );
    assert(hasTargetIndex, 'Target unique index deviceId_1_messageId_1_instrumentId_1_channelCode_1 is present');
    assert(!hasOldIndex, 'Obsolete index deviceId_1_messageId_1_channelCode_1 is absent');

    // 8. Existing old index can be migrated safely
    console.log('\nTest 8: Migration safely upgrades simulated legacy database index');
    const testSimCol = mongoose.connection.db.collection('test_simulated_legacy_rawreadings');
    await testSimCol.drop().catch(() => {});
    // Insert documents into simulated collection
    await testSimCol.insertOne({ deviceId: testDevice._id, messageId: 'MSG-OLD-1', channelCode: 'X', sampleTime: new Date() });
    // Create old index on simulated collection
    await testSimCol.createIndex({ deviceId: 1, messageId: 1, channelCode: 1 }, { unique: true, sparse: true });

    // Verify old index exists on test collection
    const simIndexesBefore = await testSimCol.indexes();
    assert(simIndexesBefore.some(i => i.name === 'deviceId_1_messageId_1_channelCode_1'), 'Simulated collection has old index');

    // Run migration logic on test collection
    const mockDb = {
      collection: (name) => {
        if (name === 'rawreadings') return testSimCol;
        return mongoose.connection.db.collection(name);
      }
    };
    const migRes = await migrateRawReadingIndex(mockDb);
    assert(migRes.droppedOld === true, 'Migration safely dropped obsolete index from simulated collection');
    assert(migRes.createdNew === true, 'Migration created target multi-slot index on simulated collection');

    // Verify existing document was not deleted
    const countAfter = await testSimCol.countDocuments();
    assert(countAfter === 1, 'Migration preserved existing raw reading documents (count === 1)');
    await testSimCol.drop().catch(() => {});

    // 9. Re-running migration does nothing harmful (idempotency)
    console.log('\nTest 9: Re-running migration is strictly idempotent');
    const reRunResult = await ensureIndexesMigrated(mongoose.connection.db);
    assert(reRunResult.rawResult.droppedOld === false, 'Re-run does not drop absent old index');
    assert(reRunResult.rawResult.createdNew === false, 'Re-run does not recreate existing new index');

    // 10. Same messageId + TEMP across Slot 1 Instrument A and Slot 2 Instrument B can persist correctly
    console.log('\nTest 10: Multi-slot packet with same channelCode "TEMP" across Slot 1 & Slot 2');
    const multiSlotMsgId = 'M-CASE-MULTI-SLOT-001';
    const multiSlotPacket = {
      schemaVersion: 1,
      deviceCode: 'DEV-CASE-01',
      gatewayCode: 'GW-CASE-01',
      timestamp: '2026-11-05T12:20:00+05:30',
      messageId: multiSlotMsgId,
      sequenceNumber: 10,
      readings: [
        {
          slot: 1,
          channels: [{ channelCode: 'TEMP', value: 24.0 }]
        },
        {
          slot: 2,
          channels: [{ channelCode: 'TEMP', value: 28.5 }]
        }
      ]
    };
    const multiSlotRes = await ingestTelemetry(multiSlotPacket);
    assert(multiSlotRes.accepted === true, 'Multi-slot packet accepted without duplicate key conflict');
    assert(multiSlotRes.resolvedSensors === 2, 'Resolved 2 sensors');
    assert(multiSlotRes.processedChannels === 2, 'Processed 2 TEMP channels (1 per slot/instrument)');

    const slot1Raw = await RawReading.findOne({ messageId: multiSlotMsgId, instrumentId: testInstA._id, channelCode: 'TEMP' });
    const slot2Raw = await RawReading.findOne({ messageId: multiSlotMsgId, instrumentId: testInstB._id, channelCode: 'TEMP' });
    assert(slot1Raw !== null && slot1Raw.rawValue === 24.0, 'Slot 1 RawReading persisted with value 24.0');
    assert(slot2Raw !== null && slot2Raw.rawValue === 28.5, 'Slot 2 RawReading persisted with value 28.5');

    // 11. Exact duplicate packet still deduplicates correctly
    console.log('\nTest 11: Exact duplicate packet deduplication');
    const dupRes = await ingestTelemetry(multiSlotPacket);
    assert(dupRes.accepted === true, 'Duplicate packet returns accepted: true');
    assert(dupRes.duplicate === true, 'Duplicate packet flagged as duplicate: true');
    const totalRawForMsg = await RawReading.countDocuments({ messageId: multiSlotMsgId });
    assert(totalRawForMsg === 2, `Total RawReadings remain exactly 2 after duplicate attempt (got: ${totalRawForMsg})`);

    // Verify LAN-PRO-01 accessMode is untouched
    console.log('\nFinal Check: LAN-PRO-01 accessMode');
    const lanProject = await Project.findOne({ code: 'LAN-PRO-01' });
    if (lanProject) {
      assert(lanProject.accessMode === 'ROLE_BASED', `LAN-PRO-01 accessMode is ROLE_BASED (got: ${lanProject.accessMode})`);
    } else {
      assert(testProject.accessMode === 'ROLE_BASED', `Test project accessMode is ROLE_BASED (got: ${testProject.accessMode})`);
    }

    console.log('\n======================================================');
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================\n');

  } finally {
    await cleanup();
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

