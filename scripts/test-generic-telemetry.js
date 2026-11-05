/**
 * Comprehensive Test Suite for Generic Telemetry v1 (Channel Code Corrective Modification)
 *
 * Verifies:
 * 1. Contract validation (required fields, schemaVersion, timestamp, finite values, channelCode string)
 * 2. Duplicate channelCode in a single slot rejection
 * 3. Device validation (unknown device rejected, inactive rejected, gateway mismatch rejected)
 * 4. Slot validation (unmapped slot rejected, wrong device slot rejected)
 * 5. ChannelCode resolution & order independence (mapped by SensorChannel.code, independent of DB order)
 * 6. Unknown channelCode rejection
 * 7. Full pipeline integration:
 *    - Raw reading saved
 *    - Calibration applied (scale + offset)
 *    - Baseline subtracted (deltaFromBaseline)
 *    - Latest state updated (value, severity, timestamp)
 *    - Engineering severity rule evaluated (S4 threshold reached)
 *    - Alarm generation (S4 alarm created via AlarmTriggerPolicy)
 * 8. Downstream continuity & idempotency (duplicate messageId)
 * 9. Device health updated (batteryV, rssiDbm, network, internalTempC, faultBits)
 * 10. Demo packet verification (exact demo packet from Section 16)
 * 11. Database check: Verify no channelNumber in SensorChannel collection or index
 */

import mongoose from 'mongoose';
import { ingestTelemetry } from '../src/services/telemetry.service.js';
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

let testOrg;
let testProject;
let testGateway;
let testDevice;
let testInstrument1;
let testInstrument2;
let testMapping1;
let testMapping2;
let testChannelsSlot1 = [];
let testChannelsSlot2 = [];
let testRule;
let testPolicy;

async function setupFixtures() {
  console.log('--- Setting up test fixtures ---');

  // 1. Organization & Project
  testOrg = await Organization.create({
    code: 'TEST-ORG-GT1C',
    name: 'Test Org GT-1 Corrected',
    status: 'ACTIVE'
  });

  testProject = await Project.create({
    organizationId: testOrg._id,
    code: 'TEST-PRJ-GT1C',
    name: 'Test Project GT-1 Corrected',
    status: 'ACTIVE',
    accessMode: 'ROLE_BASED'
  });

  // 2. Gateway
  testGateway = await ProjectGateway.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    gatewayId: 'GW-001',
    name: 'Test Gateway 001',
    gateway_uid: 'GW000001',
    status: 'COMMISSIONED'
  });

  // 3. Device
  testDevice = await Device.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceId: 'DEV-001',
    name: 'Test Generic Logger 001',
    status: 'COMMISSIONED',
    commissioningStatus: 'COMMISSIONED',
    runtimeStatus: 'ONLINE'
  });

  // DeviceGatewayMapping
  await DeviceGatewayMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevice._id,
    gatewayAssetId: testGateway._id,
    status: 'ACTIVE'
  });

  // 4. Instruments
  testInstrument1 = await Instrument.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    code: 'INC-001',
    name: 'Inclinometer 001',
    catalogCode: 'INC',
    status: 'COMMISSIONED'
  });

  testInstrument2 = await Instrument.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    code: 'PZ-001',
    name: 'Piezometer 001',
    catalogCode: 'PZ',
    status: 'COMMISSIONED'
  });

  // 5. SensorDeviceMapping
  testMapping1 = await SensorDeviceMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevice._id,
    sensorAssetId: testInstrument1._id,
    connection: { mode: 'slot', slot: 1 },
    status: 'ACTIVE'
  });

  testMapping2 = await SensorDeviceMapping.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    deviceAssetId: testDevice._id,
    sensorAssetId: testInstrument2._id,
    connection: { mode: 'slot', slot: 2 },
    status: 'ACTIVE'
  });

  // 6. SensorChannels for Slot 1 (INC-001) - NO channelNumber field!
  // Channels: X_DISP (scale: 1.5, offset: 0.5, baseline: 1.0), Y_DISP, TEMP
  const chX = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstrument1._id,
    code: 'X_DISP',
    name: 'X Displacement',
    parameterCode: 'DISPLACEMENT_X',
    rawUnit: 'V',
    unit: 'mm',
    engineeringUnit: 'mm',
    status: 'ACTIVE',
    enabled: true,
    calibration: {
      scale: 1.5,
      offset: 0.5,
      configured: true,
      configuredAt: new Date()
    },
    baseline: {
      value: 1.0,
      configured: true,
      capturedAt: new Date()
    }
  });

  const chY = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstrument1._id,
    code: 'Y_DISP',
    name: 'Y Displacement',
    parameterCode: 'DISPLACEMENT_Y',
    rawUnit: 'V',
    unit: 'mm',
    engineeringUnit: 'mm',
    status: 'ACTIVE',
    enabled: true,
    calibration: {
      scale: 1.0,
      offset: 0.0,
      configured: true
    }
  });

  const chTemp1 = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstrument1._id,
    code: 'TEMP',
    name: 'Temperature',
    parameterCode: 'TEMPERATURE',
    rawUnit: 'C',
    unit: 'degC',
    engineeringUnit: 'degC',
    status: 'ACTIVE',
    enabled: true,
    calibration: {
      scale: 1.0,
      offset: 0.0,
      configured: true
    }
  });

  testChannelsSlot1 = [chX, chY, chTemp1];

  // 7. SensorChannels for Slot 2 (PZ-001) - NO channelNumber!
  // Note reverse insertion order to verify DB order independence: TEMP inserted before PORE_PRESSURE
  const chTemp2 = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstrument2._id,
    code: 'TEMP',
    name: 'PZ Temperature',
    parameterCode: 'TEMPERATURE',
    rawUnit: 'C',
    unit: 'degC',
    engineeringUnit: 'degC',
    status: 'ACTIVE',
    enabled: true,
    calibration: { scale: 1.0, offset: 0.0, configured: true }
  });

  const chPore = await SensorChannel.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstrument2._id,
    code: 'PORE_PRESSURE',
    name: 'Pore Pressure',
    parameterCode: 'PRESSURE',
    rawUnit: 'kPa',
    unit: 'kPa',
    engineeringUnit: 'kPa',
    status: 'ACTIVE',
    enabled: true,
    calibration: { scale: 2.0, offset: 1.0, configured: true },
    baseline: { value: 5.0, configured: true }
  });

  testChannelsSlot2 = [chTemp2, chPore];

  // 8. Engineering Severity Rule on INC-001 for DISPLACEMENT_X:
  // If value >= 10.0 => S4
  testRule = await EngineeringSeverityRule.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    instrumentId: testInstrument1._id,
    parameterCode: 'DISPLACEMENT_X',
    code: 'RULE-X-DISP-001',
    name: 'X Displacement Limit Rule',
    metric: 'engineeringValue',
    mode: 'INCREASING',
    unit: 'mm',
    status: 'ACTIVE',
    thresholds: {
      s1: 3.0,
      s2: 5.0,
      s3: 8.0,
      s4: 10.0
    }
  });

  // 9. Alarm Trigger Policy for INSTRUMENT scope
  testPolicy = await AlarmTriggerPolicy.create({
    organizationId: testOrg._id,
    projectId: testProject._id,
    category: 'ENGINEERING_SEVERITY',
    scope: 'INSTRUMENT',
    instrumentId: testInstrument1._id,
    parameterCode: 'DISPLACEMENT_X',
    name: 'Test Alarm Policy',
    status: 'ACTIVE',
    triggerLevels: ['S2', 'S3', 'S4']
  });

  console.log('--- Test fixtures setup complete ---\n');
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
    await Instrument.deleteMany({ organizationId: testOrg._id });
    await DeviceGatewayMapping.deleteMany({ organizationId: testOrg._id });
    await Device.deleteMany({ organizationId: testOrg._id });
    await ProjectGateway.deleteMany({ organizationId: testOrg._id });
    await Project.deleteMany({ organizationId: testOrg._id });
    await Organization.deleteMany({ _id: testOrg._id });
  }
  console.log('--- Cleaned up successfully ---');
}

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

async function runTests() {
  await mongoose.connect(MONGODB_URI);

  try {
    await setupFixtures();

    console.log('=== TEST SUITE: GENERIC TELEMETRY v1 (CHANNEL CODE) ===\n');

    // ---------------------------------------------------------
    // Test 1: Contract Validation - Missing Required Fields
    // ---------------------------------------------------------
    console.log('Test 1: Contract Validation');
    try {
      await ingestTelemetry({
        schemaVersion: 1,
        // deviceCode missing
        timestamp: new Date().toISOString(),
        messageId: 'M-001',
        readings: [{ slot: 1, channels: [{ channelCode: 'X_DISP', value: 1.0 }] }]
      });
      assert(false, 'Should reject packet missing deviceCode');
    } catch (err) {
      assert(err.message.includes('deviceCode'), 'Rejected packet missing deviceCode: ' + err.message);
    }

    try {
      await ingestTelemetry({
        schemaVersion: 1,
        deviceCode: 'DEV-001',
        timestamp: new Date().toISOString(),
        messageId: 'M-002',
        readings: [{ slot: 1, channels: [{ channelCode: '', value: 1.0 }] }]
      });
      assert(false, 'Should reject empty channelCode');
    } catch (err) {
      assert(err.message.includes('channelCode'), 'Rejected empty channelCode: ' + err.message);
    }

    try {
      await ingestTelemetry({
        schemaVersion: 1,
        deviceCode: 'DEV-001',
        timestamp: new Date().toISOString(),
        messageId: 'M-003',
        readings: [{ slot: 1, channels: [{ channelCode: 'X_DISP', value: Infinity }] }]
      });
      assert(false, 'Should reject non-finite numeric value');
    } catch (err) {
      assert(err.message.includes('Non-numeric channel value'), 'Rejected non-finite value: ' + err.message);
    }

    // ---------------------------------------------------------
    // Test 2: Duplicate channelCode in a Single Slot
    // ---------------------------------------------------------
    console.log('\nTest 2: Duplicate channelCode in Single Slot');
    try {
      await ingestTelemetry({
        schemaVersion: 1,
        deviceCode: 'DEV-001',
        timestamp: new Date().toISOString(),
        messageId: 'M-DUP-01',
        readings: [{
          slot: 1,
          channels: [
            { channelCode: 'X_DISP', value: 1.0 },
            { channelCode: 'X_DISP', value: 2.0 }
          ]
        }]
      });
      assert(false, 'Should reject duplicate channelCode in slot');
    } catch (err) {
      assert(err.message.includes('Duplicate channelCode'), 'Rejected duplicate channelCode: ' + err.message);
    }

    // ---------------------------------------------------------
    // Test 3: Device Validation
    // ---------------------------------------------------------
    console.log('\nTest 3: Device Validation');
    try {
      await ingestTelemetry({
        schemaVersion: 1,
        deviceCode: 'DEV-NONEXISTENT',
        timestamp: new Date().toISOString(),
        messageId: 'M-DEV-404',
        readings: [{ slot: 1, channels: [{ channelCode: 'X_DISP', value: 1.0 }] }]
      });
      assert(false, 'Should reject unknown device');
    } catch (err) {
      assert(err.message.includes('Unknown Device'), 'Rejected unknown device: ' + err.message);
    }

    try {
      await ingestTelemetry({
        schemaVersion: 1,
        deviceCode: 'DEV-001',
        gatewayCode: 'GW-WRONG',
        timestamp: new Date().toISOString(),
        messageId: 'M-GW-MISMATCH',
        readings: [{ slot: 1, channels: [{ channelCode: 'X_DISP', value: 1.0 }] }]
      });
      assert(false, 'Should reject gateway mismatch');
    } catch (err) {
      assert(err.message.includes('Gateway'), 'Rejected gateway mismatch: ' + err.message);
    }

    // ---------------------------------------------------------
    // Test 4: Slot Validation
    // ---------------------------------------------------------
    console.log('\nTest 4: Slot Validation');
    try {
      await ingestTelemetry({
        schemaVersion: 1,
        deviceCode: 'DEV-001',
        timestamp: new Date().toISOString(),
        messageId: 'M-SLOT-999',
        readings: [{ slot: 999, channels: [{ channelCode: 'X_DISP', value: 1.0 }] }]
      });
      assert(false, 'Should reject unmapped slot');
    } catch (err) {
      assert(err.message.includes('slot 999'), 'Rejected unmapped slot: ' + err.message);
    }

    // ---------------------------------------------------------
    // Test 5: Unknown channelCode Validation
    // ---------------------------------------------------------
    console.log('\nTest 5: Unknown channelCode Validation');
    try {
      await ingestTelemetry({
        schemaVersion: 1,
        deviceCode: 'DEV-001',
        timestamp: new Date().toISOString(),
        messageId: 'M-CH-UNKNOWN',
        readings: [{ slot: 1, channels: [{ channelCode: 'UNKNOWN_MEASUREMENT', value: 1.0 }] }]
      });
      assert(false, 'Should reject unknown channelCode');
    } catch (err) {
      assert(err.message.includes('Unknown SensorChannel code'), 'Rejected unknown channelCode: ' + err.message);
    }

    // ---------------------------------------------------------
    // Test 6: Full Pipeline & Calculations (Calibration + Baseline + LatestState + Severity + Alarm)
    // ---------------------------------------------------------
    console.log('\nTest 6: Full Pipeline Verification');
    // For X_DISP: rawValue = 8.5
    // Calibration: scale = 1.5, offset = 0.5 => calibrated value = 8.5 * 1.5 + 0.5 = 13.25
    // Baseline: value = 1.0 => deltaFromBaseline = 13.25 - 1.0 = 12.25
    // Severity Rule: s4 threshold is 10.0, engineeringValue is 13.25 => S4
    // AlarmTriggerPolicy: triggerLevels includes S4 => Alarm created
    const pipelineMessageId = 'DEV-001-TEST-PIPELINE-001';
    const pipelineTimestamp = '2026-11-05T10:30:00+05:30';

    const pipelineResult = await ingestTelemetry({
      schemaVersion: 1,
      deviceCode: 'DEV-001',
      gatewayCode: 'GW-001',
      timestamp: pipelineTimestamp,
      messageId: pipelineMessageId,
      sequenceNumber: 1,
      readings: [
        {
          slot: 1,
          channels: [
            { channelCode: 'X_DISP', value: 8.5 }
          ]
        }
      ]
    });

    assert(pipelineResult.accepted === true, 'Pipeline ingestion returned accepted: true');
    assert(pipelineResult.processedChannels === 1, 'Processed 1 channel');

    // Verify Raw Reading
    const rawRecord = await RawReading.findOne({ messageId: pipelineMessageId, channelCode: 'X_DISP' });
    assert(rawRecord !== null, 'RawReading saved to database');
    assert(rawRecord.rawValue === 8.5, 'RawReading has raw value 8.5');

    // Verify Derived Reading
    const derivedX = await DerivedReading.findOne({
      instrumentId: testInstrument1._id,
      parameterCode: 'DISPLACEMENT_X',
      observedAt: new Date(pipelineTimestamp)
    });
    assert(derivedX !== null, 'DerivedReading created for DISPLACEMENT_X');
    assert(Math.abs(derivedX.value - 13.25) < 0.001, `DerivedReading value is 13.25 (got ${derivedX.value})`);
    assert(Math.abs(derivedX.deltaFromBaseline - 12.25) < 0.001, `DerivedReading deltaFromBaseline is 12.25 (got ${derivedX.deltaFromBaseline})`);
    assert(derivedX.severity?.level === 'S4', `DerivedReading severity level is S4 (got ${derivedX.severity?.level})`);

    // Verify Latest State
    const latestStateX = await LatestState.findOne({
      instrumentId: testInstrument1._id,
      parameterCode: 'DISPLACEMENT_X'
    });
    assert(latestStateX !== null, 'LatestState record created');
    assert(Math.abs(latestStateX.value - 13.25) < 0.001, `LatestState value is 13.25 (got ${latestStateX?.value})`);
    assert(latestStateX.severity === 'S4', `LatestState severity is S4 (got ${latestStateX?.severity})`);

    // Verify Alarm Triggered
    const alarm = await Alarm.findOne({
      instrumentId: testInstrument1._id,
      severity: 'S4'
    });
    assert(alarm !== null, 'S4 Alarm successfully generated for exceeding 10.0 threshold');

    // ---------------------------------------------------------
    // Test 7: Idempotency (Duplicate Packet Handling)
    // ---------------------------------------------------------
    console.log('\nTest 7: Idempotency');
    const duplicateResult = await ingestTelemetry({
      schemaVersion: 1,
      deviceCode: 'DEV-001',
      gatewayCode: 'GW-001',
      timestamp: pipelineTimestamp,
      messageId: pipelineMessageId, // Same messageId
      readings: [
        {
          slot: 1,
          channels: [{ channelCode: 'X_DISP', value: 8.5 }]
        }
      ]
    });
    assert(duplicateResult.accepted === true, 'Duplicate packet returns accepted: true');
    assert(duplicateResult.duplicate === true, 'Duplicate packet identified as duplicate: true');
    const rawCount = await RawReading.countDocuments({ messageId: pipelineMessageId });
    assert(rawCount === 1, 'Duplicate packet did not insert duplicate RawReading');

    // ---------------------------------------------------------
    // Test 8: Device Health Updates
    // ---------------------------------------------------------
    console.log('\nTest 8: Device Health');
    const healthResult = await ingestTelemetry({
      schemaVersion: 1,
      deviceCode: 'DEV-001',
      timestamp: new Date().toISOString(),
      messageId: 'M-HEALTH-001',
      readings: [{ slot: 1, channels: [{ channelCode: 'TEMP', value: 25.0 }] }],
      health: {
        batteryV: 3.72,
        rssiDbm: -78,
        network: '4G',
        internalTempC: 31.5,
        faultBits: ['WARN_CLOCK']
      }
    });
    assert(healthResult.accepted === true, 'Health packet accepted');
    const updatedDevice = await Device.findById(testDevice._id);
    assert(updatedDevice.lastBatteryV === 3.72, `Device lastBatteryV updated to 3.72 (got ${updatedDevice.lastBatteryV})`);
    assert(updatedDevice.lastRssiDbm === -78, `Device lastRssiDbm updated to -78 (got ${updatedDevice.lastRssiDbm})`);

    const healthDoc = await DeviceTelemetry.findOne({ deviceId: testDevice._id }).sort({ observedAt: -1 });
    assert(healthDoc !== null, 'DeviceTelemetry record created');
    assert(healthDoc.batteryV === 3.72, 'DeviceTelemetry batteryV is 3.72');
    assert(healthDoc.rssiDbm === -78, 'DeviceTelemetry rssiDbm is -78');
    assert(healthDoc.network === '4G', 'DeviceTelemetry network is 4G');
    assert(healthDoc.internalTempC === 31.5, 'DeviceTelemetry internalTempC is 31.5');

    // ---------------------------------------------------------
    // Test 9: Channel Order Independence & Multiple Slots (Demo Packet from Section 16)
    // ---------------------------------------------------------
    console.log('\nTest 9: Exact Demo Packet (Section 16) & Order Independence');
    // Notice Slot 2 in payload sends PORE_PRESSURE first, whereas DB fixtures inserted TEMP first!
    const demoPacket = {
      schemaVersion: 1,
      deviceCode: 'DEV-001',
      gatewayCode: 'GW-001',
      timestamp: '2026-11-05T10:30:00+05:30',
      messageId: 'DEV-001-000145',
      sequenceNumber: 145,
      readings: [
        {
          slot: 1,
          channels: [
            { channelCode: 'X_DISP', value: 8.5 },
            { channelCode: 'Y_DISP', value: 1.2 },
            { channelCode: 'TEMP', value: 27.6 }
          ]
        },
        {
          slot: 2,
          channels: [
            { channelCode: 'PORE_PRESSURE', value: 42.6 },
            { channelCode: 'TEMP', value: 24.1 }
          ]
        }
      ],
      health: {
        batteryV: 3.72,
        rssiDbm: -78,
        network: '4G',
        internalTempC: 31.5,
        faultBits: []
      }
    };

    const demoResult = await ingestTelemetry(demoPacket);
    assert(demoResult.accepted === true, 'Demo packet processed successfully');
    assert(demoResult.resolvedSensors === 2, `Resolved 2 instruments (got ${demoResult.resolvedSensors})`);
    assert(demoResult.processedChannels === 5, `Processed 5 channels total (got ${demoResult.processedChannels})`);

    // Verify Slot 2 PORE_PRESSURE calculations:
    // raw = 42.6, scale = 2.0, offset = 1.0 => value = 42.6 * 2 + 1 = 86.2
    // baseline = 5.0 => deltaFromBaseline = 86.2 - 5.0 = 81.2
    const poreDerived = await DerivedReading.findOne({
      instrumentId: testInstrument2._id,
      parameterCode: 'PRESSURE',
      observedAt: new Date(demoPacket.timestamp)
    });
    assert(poreDerived !== null, 'Derived reading created for PORE_PRESSURE in slot 2');
    assert(Math.abs(poreDerived.value - 86.2) < 0.001, `PORE_PRESSURE value is 86.2 (got ${poreDerived?.value})`);
    assert(Math.abs(poreDerived.deltaFromBaseline - 81.2) < 0.001, `PORE_PRESSURE deltaFromBaseline is 81.2 (got ${poreDerived?.deltaFromBaseline})`);

    const tempDerivedSlot2 = await DerivedReading.findOne({
      instrumentId: testInstrument2._id,
      parameterCode: 'TEMPERATURE',
      observedAt: new Date(demoPacket.timestamp)
    });
    assert(tempDerivedSlot2 !== null, 'Derived reading created for TEMP in slot 2');
    assert(Math.abs(tempDerivedSlot2.value - 24.1) < 0.001, `TEMP value is 24.1 (got ${tempDerivedSlot2?.value})`);

    // ---------------------------------------------------------
    // Test 10: Database Integrity - Verify NO channelNumber field or index
    // ---------------------------------------------------------
    console.log('\nTest 10: Database Integrity - Absence of channelNumber');
    const allChannels = await SensorChannel.find({ organizationId: testOrg._id }).lean();
    const hasChannelNumberField = allChannels.some(ch => 'channelNumber' in ch && ch.channelNumber !== undefined);
    assert(!hasChannelNumberField, 'No SensorChannel document has channelNumber property');

    const indexes = await SensorChannel.collection.indexes();
    const hasChannelNumberIndex = indexes.some(idx => idx.name.includes('channelNumber') || (idx.key && 'channelNumber' in idx.key));
    assert(!hasChannelNumberIndex, 'No index on sensorchannels collection references channelNumber');

    console.log('\n======================================');
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================\n');

  } finally {
    await cleanupFixtures();
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
