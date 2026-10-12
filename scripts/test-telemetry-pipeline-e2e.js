import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import {
  Device,
  DeviceGatewayMapping,
  Instrument,
  LatestState,
  Project,
  ProjectGateway,
  RawReading,
  DerivedReading,
  SensorChannel,
  SensorDeviceMapping
} from '../src/models/index.js';

let server;

async function startTestServer() {
  const app = createApp();
  return new Promise((resolve) => {
    // Start on port 3099 to avoid colliding with any running dev server
    server = app.listen(3099, '127.0.0.1', () => {
      resolve('http://127.0.0.1:3099/api/v1/telemetry/ingest');
    });
  });
}

async function stopTestServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('RUNNING E2E TELEMETRY INGESTION VALIDATION');
  console.log('====================================================');

  await mongoose.connect('mongodb://127.0.0.1:27017/geonexa');
  const ingestUrl = await startTestServer();

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`\x1b[32m✔ PASS:\x1b[0m ${message}`);
      passed += 1;
    } else {
      console.error(`\x1b[31m✖ FAIL:\x1b[0m ${message}`);
      failed += 1;
    }
  }

  try {
    // Record initial snapshot of commissioned assets
    const initDeviceCount = await Device.countDocuments();
    const initInstCount = await Instrument.countDocuments();
    const initSdmCount = await SensorDeviceMapping.countDocuments();
    const initDgmCount = await DeviceGatewayMapping.countDocuments();

    // ----------------------------------------------------
    // TEST CHAIN 1: Automatic Inclinometer (INC-2026-0001)
    // ----------------------------------------------------
    console.log('\n--- TEST CHAIN 1: Automatic Inclinometer (INC-2026-0001) ---');
    const msgIdInc = `test-inc-${Date.now()}`;
    const incPacket = {
      deviceCode: 'SNRS485-2026-0001',
      gatewayCode: 'GWLR-2026-0001',
      timestamp: new Date().toISOString(),
      messageId: msgIdInc,
      source: 'SIMULATOR',
      readings: [
        {
          slot: 1,
          values: {
            x_displacement: 1.25,
            y_displacement: -0.32,
            temperature: 27.4
          }
        }
      ]
    };

    const res1 = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incPacket)
    });
    const body1 = await res1.json();

    assert(res1.status === 200, `HTTP status 200 for INC-2026-0001 (got ${res1.status})`);
    assert(body1.accepted === true, `Packet accepted: ${body1.accepted}`);
    assert(body1.device === 'SNRS485-2026-0001', `Device code matches: ${body1.device}`);
    assert(body1.resolvedSensors === 1, `Resolved 1 sensor: ${body1.resolvedSensors}`);
    assert(body1.processedChannels === 3, `Processed 3 channels: ${body1.processedChannels}`);
    assert(body1.source === 'SIMULATOR', `Source marked SIMULATOR: ${body1.source}`);

    // Verify DB Persistence for INC-2026-0001
    const rawInc = await RawReading.find({ messageId: msgIdInc }).lean();
    assert(rawInc.length === 3, `Persisted 3 RawReadings for INC-2026-0001 (got ${rawInc.length})`);
    const xRaw = rawInc.find((r) => r.channelCode === 'x_displacement');
    const yRaw = rawInc.find((r) => r.channelCode === 'y_displacement');
    const tempRaw = rawInc.find((r) => r.channelCode === 'temperature');

    assert(Boolean(xRaw && yRaw && tempRaw), 'All 3 channels (x_displacement, y_displacement, temperature) exist in RawReading');
    assert(xRaw?.sourceMetadata?.source === 'SIMULATOR', 'Raw reading sourceMetadata.source is SIMULATOR');

    const derivedInc = await DerivedReading.find({ rawReadingId: { $in: rawInc.map((r) => r._id) } }).lean();
    assert(derivedInc.length >= 3, `Persisted at least 3 DerivedReadings (got ${derivedInc.length})`);
    const xDerived = derivedInc.find((r) => r.parameterCode === 'x_displacement');
    assert(xDerived?.value === 1.25, `Calibration applied (scale=1, offset=0 -> 1.25, got ${xDerived?.value})`);
    assert(xDerived?.deltaFromBaseline === 1.25, `Baseline delta calculated (value - 0 = 1.25, got ${xDerived?.deltaFromBaseline})`);
    assert(xDerived?.metadata?.source === 'SIMULATOR', `Derived reading metadata.source is SIMULATOR`);

    // Verify LatestState was updated
    const latestInc = await LatestState.findOne({ instrumentId: xRaw.instrumentId, parameterCode: 'x_displacement' }).lean();
    assert(latestInc?.value === 1.25, `LatestState updated for x_displacement (got ${latestInc?.value})`);

    // ----------------------------------------------------
    // TEST CHAIN 2: VW Piezometer (PZVW-2026-0001)
    // ----------------------------------------------------
    console.log('\n--- TEST CHAIN 2: VW Piezometer (PZVW-2026-0001) ---');
    const msgIdPz = `test-pz-${Date.now()}`;
    const pzPacket = {
      deviceCode: 'DLVW08-2026-0001',
      gatewayCode: 'GWLR-2026-0001',
      timestamp: new Date().toISOString(),
      messageId: msgIdPz,
      source: 'SIMULATOR',
      readings: [
        {
          slot: 1,
          values: {
            pore_pressure: 45.2,
            temperature: 22.8
          }
        }
      ]
    };

    const res2 = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pzPacket)
    });
    const body2 = await res2.json();

    assert(res2.status === 200, `HTTP status 200 for PZVW-2026-0001 (got ${res2.status})`);
    assert(body2.accepted === true, `Packet accepted: ${body2.accepted}`);
    assert(body2.processedChannels === 2, `Processed 2 channels for PZVW: ${body2.processedChannels}`);

    const rawPz = await RawReading.find({ messageId: msgIdPz }).lean();
    assert(rawPz.length === 2, `Persisted 2 RawReadings for PZVW-2026-0001 (got ${rawPz.length})`);
    const pzDerived = await DerivedReading.find({ rawReadingId: { $in: rawPz.map((r) => r._id) } }).lean();
    const pzPore = pzDerived.find((r) => r.parameterCode === 'pore_pressure');
    assert(pzPore?.value === 45.2, `Calibration applied for pore_pressure (got ${pzPore?.value})`);

    // ----------------------------------------------------
    // NEGATIVE TEST 1: Unknown Device
    // ----------------------------------------------------
    console.log('\n--- NEGATIVE TEST 1: Unknown Device ---');
    const badDevRes = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceCode: 'UNKNOWN-DEVICE',
        timestamp: new Date().toISOString(),
        readings: [{ slot: 1, values: { x_displacement: 1.0 } }]
      })
    });
    const badDevBody = await badDevRes.json();
    assert(badDevRes.status === 404, `Unknown Device rejected with 404 (got ${badDevRes.status})`);
    assert(badDevBody.message.includes('Unknown Device'), `Error message mentions Unknown Device: ${badDevBody.message}`);

    // ----------------------------------------------------
    // NEGATIVE TEST 2: Unknown Slot
    // ----------------------------------------------------
    console.log('\n--- NEGATIVE TEST 2: Unknown Slot ---');
    const badSlotRes = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceCode: 'SNRS485-2026-0001',
        gatewayCode: 'GWLR-2026-0001',
        timestamp: new Date().toISOString(),
        readings: [{ slot: 99, values: { x_displacement: 1.0 } }]
      })
    });
    const badSlotBody = await badSlotRes.json();
    assert(badSlotRes.status === 400, `Unknown Slot rejected with 400 (got ${badSlotRes.status})`);
    assert(badSlotBody.message.includes('No active SensorDeviceMapping'), `Error mentions no active mapping: ${badSlotBody.message}`);

    // ----------------------------------------------------
    // NEGATIVE TEST 3: Unknown Channel
    // ----------------------------------------------------
    console.log('\n--- NEGATIVE TEST 3: Unknown Channel ---');
    const badChRes = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceCode: 'SNRS485-2026-0001',
        gatewayCode: 'GWLR-2026-0001',
        timestamp: new Date().toISOString(),
        readings: [{ slot: 1, values: { fake_channel: 123 } }]
      })
    });
    const badChBody = await badChRes.json();
    assert(badChRes.status === 400, `Unknown Channel rejected with 400 (got ${badChRes.status})`);
    assert(badChBody.message.includes('Unknown SensorChannel'), `Error mentions Unknown SensorChannel: ${badChBody.message}`);
    const fakeChCheck = await SensorChannel.findOne({ code: 'fake_channel' });
    assert(!fakeChCheck, 'No fake_channel was created in SensorChannel collection');

    // ----------------------------------------------------
    // NEGATIVE TEST 4: Duplicate Packet Protection
    // ----------------------------------------------------
    console.log('\n--- NEGATIVE TEST 4: Duplicate Packet Protection ---');
    const dupRes = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incPacket)
    });
    const dupBody = await dupRes.json();
    assert(dupRes.status === 200, `Duplicate packet handled with 200 (got ${dupRes.status})`);
    assert(dupBody.duplicate === true, `Duplicate flag is true: ${dupBody.duplicate}`);
    assert(dupBody.storedMeasurements === 0, `No new measurements stored: ${dupBody.storedMeasurements}`);
    const dupCount = await RawReading.countDocuments({ messageId: msgIdInc });
    assert(dupCount === 3, `Count of RawReadings with messageId remains 3 (no duplicates): ${dupCount}`);

    // ----------------------------------------------------
    // NEGATIVE TEST 5: Wrong Gateway
    // ----------------------------------------------------
    console.log('\n--- NEGATIVE TEST 5: Wrong Gateway Mapping ---');
    // Subcase 5a: Nonexistent gateway
    const wrongGwRes = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceCode: 'SNRS485-2026-0001',
        gatewayCode: 'GWLR-NONEXISTENT',
        timestamp: new Date().toISOString(),
        readings: [{ slot: 1, values: { x_displacement: 1.0 } }]
      })
    });
    assert(wrongGwRes.status === 404, `Nonexistent gateway rejected with 404 (got ${wrongGwRes.status})`);

    // Subcase 5b: Gateway exists, but is NOT the one mapped in DeviceGatewayMapping
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    const tempGw = await ProjectGateway.create({
      organizationId: project.organizationId,
      projectId: project._id,
      gatewayId: 'GW-OTHER-TEMP',
      name: 'Temp Other Gateway',
      gateway_uid: 'GW999999',
      status: 'COMMISSIONED'
    });

    const mismatchGwRes = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceCode: 'SNRS485-2026-0001',
        gatewayCode: 'GW-OTHER-TEMP',
        timestamp: new Date().toISOString(),
        readings: [{ slot: 1, values: { x_displacement: 1.0 } }]
      })
    });
    const mismatchBody = await mismatchGwRes.json();
    assert(mismatchGwRes.status === 400, `Incompatible gateway mapping rejected with 400 (got ${mismatchGwRes.status})`);
    assert(mismatchBody.message.includes('Incompatible Gateway mapping'), `Error mentions Incompatible Gateway mapping: ${mismatchBody.message}`);

    await ProjectGateway.deleteOne({ _id: tempGw._id });

    // Verify Commissioned Data Untouched
    const finalDeviceCount = await Device.countDocuments();
    const finalInstCount = await Instrument.countDocuments();
    const finalSdmCount = await SensorDeviceMapping.countDocuments();
    const finalDgmCount = await DeviceGatewayMapping.countDocuments();

    assert(finalDeviceCount === initDeviceCount, `Device count untouched: ${finalDeviceCount} == ${initDeviceCount}`);
    assert(finalInstCount === initInstCount, `Instrument count untouched: ${finalInstCount} == ${initInstCount}`);
    assert(finalSdmCount === initSdmCount, `SensorDeviceMapping count untouched: ${finalSdmCount} == ${initSdmCount}`);
    assert(finalDgmCount === initDgmCount, `DeviceGatewayMapping count untouched: ${finalDgmCount} == ${initDgmCount}`);

    console.log('\n====================================================');
    console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    if (failed > 0) process.exit(1);
  } finally {
    await stopTestServer();
    await mongoose.disconnect();
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
