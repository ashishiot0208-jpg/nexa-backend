#!/usr/bin/env node

/**
 * GeoNexa Telemetry Simulator
 *
 * DEVELOPMENT / TEST ONLY.
 * Sends simulated telemetry packets over HTTP through the canonical ingestion endpoint.
 *
 * SAFETY RULES:
 * 1. Rejected if NODE_ENV=production (unless ALLOW_SIMULATOR_OVERRIDE=true).
 * 2. Does NOT connect to MongoDB or insert fake data directly into database models.
 * 3. Clearly marks source = 'SIMULATOR'.
 */

// Production safety check
if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SIMULATOR_OVERRIDE) {
  console.error('\n[SAFETY ERROR] Telemetry simulator cannot run in production (NODE_ENV=production).');
  console.error('To override in testing, set ALLOW_SIMULATOR_OVERRIDE=true.\n');
  process.exit(1);
}

console.log('====================================================');
console.log('TELEMETRY SIMULATOR');
console.log('DEVELOPMENT DATA ONLY');
console.log('====================================================');

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < args.length && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }
  return defaultValue;
}
function hasArg(name) {
  return args.includes(`--${name}`);
}

const deviceCode = getArg('device', 'SNRS485-2026-0001');
const gatewayCode = getArg('gateway', 'GWLR-2026-0001');
const slot = Number(getArg('slot', '1'));
const intervalSec = getArg('interval', null) ? Math.max(1, Number(getArg('interval', '10'))) : null;
const isOnce = hasArg('once') || !intervalSec;
const port = process.env.PORT || 3000;
const defaultUrl = `http://127.0.0.1:${port}/api/v1/telemetry/ingest`;
const targetUrl = getArg('url', defaultUrl);

// Configured device profiles for test chains
const DEVICE_PROFILES = {
  'SNRS485-2026-0001': {
    defaultSlot: 1,
    defaultGateway: 'GWLR-2026-0001',
    description: 'Automatic Inclinometer (INC-2026-0001)',
    generateValues: (step) => ({
      x_displacement: Number((1.25 + Math.sin(step * 0.2) * 0.08).toFixed(3)),
      y_displacement: Number((-0.32 + Math.cos(step * 0.2) * 0.05).toFixed(3)),
      temperature: Number((27.4 + Math.sin(step * 0.1) * 0.3).toFixed(2))
    })
  },
  'DLVW08-2026-0001': {
    defaultSlot: 1,
    defaultGateway: 'GWLR-2026-0001',
    description: 'Vibrating Wire Piezometer (PZVW-2026-0001)',
    generateValues: (step) => ({
      pore_pressure: Number((45.2 + Math.sin(step * 0.15) * 0.6).toFixed(2)),
      temperature: Number((22.8 + Math.cos(step * 0.1) * 0.2).toFixed(2))
    })
  }
};

let stepCount = 0;

async function sendPacket() {
  stepCount += 1;
  const now = new Date();
  const profile = DEVICE_PROFILES[deviceCode];

  let values;
  const rawValuesArg = getArg('values', null);
  if (rawValuesArg) {
    try {
      values = JSON.parse(rawValuesArg);
    } catch {
      console.error(`Invalid --values JSON: ${rawValuesArg}`);
      process.exit(1);
    }
  } else if (profile) {
    values = profile.generateValues(stepCount);
  } else {
    // Generic fallback development values
    values = {
      channel_1: Number((10.0 + (stepCount % 5) * 0.2).toFixed(2)),
      temperature: 25.0
    };
  }

  const packet = {
    deviceCode,
    gatewayCode: gatewayCode || (profile ? profile.defaultGateway : undefined),
    timestamp: now.toISOString(),
    messageId: `SIM-${deviceCode}-${Date.now()}-${stepCount}`,
    source: 'SIMULATOR',
    readings: [
      {
        slot,
        values
      }
    ]
  };

  console.log(`\n[${now.toISOString()}] Sending packet #${stepCount} to ${targetUrl}:`);
  console.log(JSON.stringify(packet, null, 2));

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client': 'geonexa-telemetry-simulator'
      },
      body: JSON.stringify(packet)
    });

    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`\x1b[32m✔ Accepted (${res.status}):\x1b[0m`, JSON.stringify(body));
    } else {
      console.log(`\x1b[31m✖ Rejected (${res.status}):\x1b[0m`, JSON.stringify(body));
      if (isOnce) process.exit(1);
    }
  } catch (err) {
    console.error(`\x1b[31m✖ Connection error:\x1b[0m ${err.message}`);
    console.error(`  Ensure GeoNexa backend server is running on ${targetUrl}`);
    if (isOnce) process.exit(1);
  }
}

async function run() {
  console.log(`Device:      ${deviceCode}`);
  console.log(`Gateway:     ${gatewayCode || 'None'}`);
  console.log(`Slot:        ${slot}`);
  console.log(`Target:      ${targetUrl}`);
  console.log(`Mode:        ${isOnce ? 'Single packet (--once)' : `Continuous (${intervalSec}s interval)`}`);

  await sendPacket();

  if (isOnce) {
    console.log('\n[SIMULATOR] Completed single packet transmission.');
    process.exit(0);
  }

  console.log(`\nRunning continuously every ${intervalSec}s. Press Ctrl+C to stop.`);
  setInterval(sendPacket, intervalSec * 1000);
}

run();
