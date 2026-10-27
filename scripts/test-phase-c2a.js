import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import {
  Device,
  DeviceGatewayMapping,
  Instrument,
  Project,
  SensorChannel,
  SensorDeviceMapping
} from '../src/models/index.js';
import { getInstrumentOperationalSummary } from '../src/services/instrument-summary.service.js';

let server;

async function startTestServer() {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(3098, '127.0.0.1', () => {
      resolve('http://127.0.0.1:3098/api/v1');
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
  console.log('PHASE C2A — OPERATIONAL SUMMARY & BINDING TEST SUITE');
  console.log('====================================================\n');

  await mongoose.connect('mongodb://127.0.0.1:27017/geonexa');
  const baseUrl = await startTestServer();

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
    const inst = await Instrument.findOne({ code: 'INC-2026-0001' }).lean();
    if (!inst) throw new Error('Test instrument INC-2026-0001 not found');

    const initialDevCount = await Device.countDocuments();
    const initialInstCount = await Instrument.countDocuments();
    const initialSdmCount = await SensorDeviceMapping.countDocuments();
    const initialDgmCount = await DeviceGatewayMapping.countDocuments();

    // 1. Send simulated telemetry packet via HTTP ingestion (Simulator path)
    const t1 = new Date();
    const simPacket = {
      deviceCode: 'SNRS485-2026-0001',
      gatewayCode: 'GWLR-2026-0001',
      timestamp: t1.toISOString(),
      messageId: `sim-c2a-${Date.now()}`,
      source: 'SIMULATOR',
      readings: [
        {
          slot: 1,
          values: {
            x_displacement: 1.340,
            y_displacement: -0.285,
            temperature: 28.10
          }
        }
      ]
    };

    const ingestRes = await fetch(`${baseUrl}/telemetry/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simPacket)
    });
    const ingestBody = await ingestRes.json();
    assert(ingestRes.status === 200 && ingestBody.accepted === true, 'Telemetry ingested through HTTP pipeline');

    // 2. Fetch Operational Summary
    const summary = await getInstrumentOperationalSummary(inst._id);
    assert(Boolean(summary), 'getInstrumentOperationalSummary returned summary object');

    // 3. Verification of Acceptance Criteria
    assert(summary.instrument.typeName === 'Automatic Inclinometer', `1. Type = Automatic Inclinometer (got '${summary.instrument.typeName}')`);
    assert(summary.instrument.model === 'INC-RS485-01', `2. Model = INC-RS485-01 (got '${summary.instrument.model}')`);
    assert(summary.location.siteName === 'Site 1', `3. Site = Site 1 (got '${summary.location.siteName}')`);
    assert(summary.location.zoneName === 'zone1', `4. Zone = zone1 (got '${summary.location.zoneName}')`);
    assert(summary.location.longitude === 55.67, `5. Longitude = 55.67 (got ${summary.location.longitude})`);
    assert(summary.location.latitude === 25.33, `6. Latitude = 25.33 (got ${summary.location.latitude})`);
    assert(summary.location.depthM === 1, `7. Depth = 1 m (got ${summary.location.depthM})`);
    assert(summary.location.orientationDeg === 15.7, `8. Orientation = 15.7° (got ${summary.location.orientationDeg})`);
    assert(summary.connection.device?.deviceId === 'SNRS485-2026-0001', `9. Device = SNRS485-2026-0001 (got '${summary.connection.device?.deviceId}')`);
    assert(summary.connection.slot === 1, `10. Slot = 1 (got ${summary.connection.slot})`);
    assert(summary.connection.gateway?.gatewayId === 'GWLR-2026-0001', `11. Gateway = GWLR-2026-0001 (got '${summary.connection.gateway?.gatewayId}')`);

    const channelCodes = summary.channels.map(c => c.code);
    assert(channelCodes.includes('x_displacement') && channelCodes.includes('y_displacement') && channelCodes.includes('temperature'),
      `12. Channels dynamically show X/Y/Temperature (got ${channelCodes.join(', ')})`);

    assert(summary.latest.channelLabel === 'X displacement', `13. Latest identifies its channel (got '${summary.latest.channelLabel}')`);
    assert(summary.latest.engineeringValue === 1.340, `14. Latest engineering value comes from telemetry (got ${summary.latest.engineeringValue})`);
    assert(summary.latest.rawValue === 1.340, `15. Raw sample comes from RawReading (got ${summary.latest.rawValue} ${summary.latest.rawUnit})`);
    assert(summary.latest.baselineValue === 0, `16. Baseline comes from SensorChannel (got ${summary.latest.baselineValue})`);
    assert(Number.isFinite(summary.operational.rate), `17. Rate is real numeric value computed from dt (got ${summary.operational.rate} mm/h)`);
    assert(new Date(summary.latest.timestamp).getTime() === t1.getTime(), `18. Last sample is real telemetry timestamp (got ${summary.latest.timestamp})`);
    assert(summary.operational.quality === 'VALID', `19. Quality is real evaluation (got '${summary.operational.quality}')`);
    assert(summary.operational.severity === 'NOT EVALUATED', `20. S-level is NOT EVALUATED because no rule set is configured (got '${summary.operational.severity}')`);
    assert(summary.operational.health.startsWith('H'), `21. H-level is real health evaluation (got '${summary.operational.health}')`);
    assert(summary.operational.confidence === null, `22. Confidence is NOT EVALUATED without rule set (got ${summary.operational.confidence})`);
    assert(summary.connection.gateway?.runtimeStatus.includes('Unknown') || summary.connection.gateway?.runtimeStatus.includes('ONLINE'),
      `26-27. Gateway runtime status is not automatically labeled OFFLINE (got '${summary.connection.gateway?.runtimeStatus}')`);
    assert(summary.alarms.length === 0, `28. No fake alarms created (count = ${summary.alarms.length})`);

    // Verify Commissioning data untouched
    const finalDevCount = await Device.countDocuments();
    const finalInstCount = await Instrument.countDocuments();
    const finalSdmCount = await SensorDeviceMapping.countDocuments();
    const finalDgmCount = await DeviceGatewayMapping.countDocuments();

    assert(finalDevCount === initialDevCount && finalInstCount === initialInstCount &&
           finalSdmCount === initialSdmCount && finalDgmCount === initialDgmCount,
      '30. Commissioning records and mappings remain completely unchanged');

    console.log('\n====================================================');
    console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================\n');

    if (failed > 0) process.exit(1);
  } finally {
    await stopTestServer();
    await mongoose.disconnect();
  }
}

runTests().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});
