#!/usr/bin/env node
/**
 * NexaIQ Field Device Simulator CLI
 *
 * Usage:
 *   node scripts/simulator/cli.js --config scripts/simulator/configs/dev-001.json
 *   npm run simulator -- --config scripts/simulator/configs/dev-001.json
 *   node scripts/simulator/cli.js --scenario SPIKE --once
 */

import path from 'node:path';
import { loadConfigFile, validateConfig } from './config.js';
import { DeviceSimulator } from './simulator.js';

// Parse arguments
const args = process.argv.slice(2);

function getArg(flag, defaultValue = null) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return defaultValue;
}

function hasArg(flag) {
  return args.includes(flag);
}

const configPath = getArg('--config', './scripts/simulator/configs/dev-001.json');
const isOnce = hasArg('--once');
const countArg = getArg('--count');
const countLimit = countArg ? Math.max(1, parseInt(countArg, 10)) : (isOnce ? 1 : null);

// Load base config
let rawConfig;
try {
  rawConfig = loadConfigFile(configPath);
} catch (err) {
  console.error(`\n[FATAL] Failed to load simulator config: ${err.message}\n`);
  process.exit(1);
}

// Apply CLI overrides if provided
if (getArg('--device')) rawConfig.deviceCode = getArg('--device');
if (getArg('--gateway')) rawConfig.gatewayCode = getArg('--gateway');
if (getArg('--scenario')) rawConfig.scenario = getArg('--scenario');
if (getArg('--url')) rawConfig.targetUrl = getArg('--url');
if (getArg('--key')) rawConfig.apiKey = getArg('--key');
if (getArg('--api-key')) rawConfig.apiKey = getArg('--api-key');
if (getArg('--interval')) {
  const intVal = Number(getArg('--interval'));
  rawConfig.intervalMs = intVal < 100 ? intVal * 1000 : intVal;
}

let config;
try {
  config = validateConfig(rawConfig);
} catch (err) {
  console.error(`\n[FATAL] Simulator config error: ${err.message}\n`);
  process.exit(1);
}

const defaultPort = process.env.PORT || 3000;
const targetUrl = config.targetUrl || `http://127.0.0.1:${defaultPort}/api/v1/telemetry/ingest`;

const maskedKey = config.apiKey
  ? `Configured (${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-4)})`
  : 'Not configured';

console.log('====================================================');
console.log('NexaIQ Physical Device Simulator (Phase GT-2)');
console.log('====================================================');
console.log(`Device       : ${config.deviceCode}`);
console.log(`Gateway      : ${config.gatewayCode || 'None'}`);
console.log(`Device Auth  : ${maskedKey}`);
console.log(`Interval     : ${(config.intervalMs / 1000).toFixed(1)} seconds`);
console.log(`Slots        : ${config.slots.length}`);
const totalChannels = config.slots.reduce((sum, s) => sum + s.channels.length, 0);
console.log(`Channels     : ${totalChannels}`);
console.log(`Scenario     : ${config.scenario}`);
console.log(`Endpoint     : ${targetUrl}`);
if (countLimit) console.log(`Mode         : Send ${countLimit} packet(s) and exit`);
console.log('====================================================\n');

const stateFile = path.resolve(`./.simulator-state-${config.deviceCode}.json`);
const sim = new DeviceSimulator(config, {
  targetUrl,
  stateFilePath: stateFile
});

let packetsCount = 0;

function formatTime(d = new Date()) {
  return d.toTimeString().split(' ')[0];
}

sim.on('packetSending', (packet) => {
  // Silent before response
});

sim.on('packetSuccess', ({ packet, result }) => {
  packetsCount++;
  const timeStr = formatTime();
  const accepted = result.data?.accepted !== undefined ? result.data.accepted : true;
  const chCount = packet.readings.reduce((sum, r) => sum + r.channels.length, 0);
  console.log(`[${timeStr}] ${packet.deviceCode} seq=${packet.sequenceNumber} channels=${chCount} HTTP=${result.status} accepted=${accepted}`);

  if (countLimit && packetsCount >= countLimit) {
    console.log(`\nCompleted ${packetsCount} packet transmission(s). Exiting cleanly.`);
    sim.stop();
    process.exit(0);
  }
});

sim.on('packetError', ({ packet, result, error }) => {
  packetsCount++;
  const timeStr = formatTime();
  const statusStr = result?.status ? `HTTP=${result.status}` : 'ERR';
  console.error(`[${timeStr}] ${packet.deviceCode} seq=${packet.sequenceNumber} ${statusStr} FAILED: ${error?.message || 'Unknown error'}`);

  if (countLimit && packetsCount >= countLimit) {
    sim.stop();
    process.exit(1);
  }
});

sim.on('retry', ({ deviceCode, attempt, maxRetries, error, backoffMs }) => {
  const timeStr = formatTime();
  console.warn(`[${timeStr}] ${deviceCode} [RETRY] attempt=${attempt}/${maxRetries} in ${backoffMs}ms: ${error?.message || 'Network error'}`);
});

sim.on('skipped', ({ deviceCode, reason }) => {
  const timeStr = formatTime();
  console.log(`[${timeStr}] ${deviceCode} [OFFLINE] Simulation pause active: transmission skipped (${reason})`);
  if (countLimit) {
    sim.stop();
    process.exit(0);
  }
});

// Handle graceful termination
function handleShutdown(signal) {
  console.log(`\n[${formatTime()}] ${signal} received. Stopping simulator cleanly...`);
  sim.stop();
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Start
sim.start();

