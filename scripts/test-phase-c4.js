#!/usr/bin/env node

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  Instrument,
  Device,
  SensorChannel,
  Alarm,
  User,
  OrganizationMember,
  EngineeringSeverityRule,
  SensorDeviceMapping,
  DeviceGatewayMapping
} from '../src/models/index.js';
import { getInstrumentOperationalSummary } from '../src/services/instrument-summary.service.js';

let server;
const TEST_PORT = 3108;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

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

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    throw new Error(message);
  }
  console.log(`[PASS] ${message}`);
}

async function runC4Verification() {
  console.log('====================================================');
  console.log('PHASE C4 — OPERATIONAL MAP INTEGRATION VERIFICATION');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  const initialAlarmCount = await Alarm.countDocuments();

  try {
    // 1. Resolve Project LAN-PRO-01
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(Boolean(project), `Found project LAN-PRO-01 (${project?._id})`);

    // 2. Setup auth token
    const user = await User.findOne({ organizationId: project.organizationId }) || await User.findOne();
    const member = await OrganizationMember.findOne({ userId: user._id, status: 'ACTIVE' }).lean();
    const token = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: member?.organizationRole || 'OWNER' },
      env.jwtSecret,
      { subject: user._id.toString(), expiresIn: '1h' }
    );

    // 3. Request GET /api/v1/projects/:projectId/map/instruments
    const res = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/map/instruments`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(res.status === 200, `GET /map/instruments returned HTTP 200 (actual: ${res.status})`);

    const markers = await res.json();
    assert(Array.isArray(markers), 'Returned payload is an array');
    assert(markers.length >= 6, `Returned all project instruments (${markers.length} records)`);

    // 4. Verify INC-2026-0001
    const inc1 = markers.find(m => m.code === 'INC-2026-0001');
    assert(Boolean(inc1), 'INC-2026-0001 present in response');
    assert(Array.isArray(inc1.coordinates) && inc1.coordinates[0] === 55.67 && inc1.coordinates[1] === 25.33,
      `INC-2026-0001 coordinates [${inc1.coordinates}] match commissioned location [55.67, 25.33]`);
    assert(inc1.severity === 'S1', `INC-2026-0001 severity is '${inc1.severity}' (evaluated S1)`);
    assert(inc1.latestValue === 1.4, `INC-2026-0001 latest measurement is ${inc1.latestValue} ${inc1.unit}`);
    assert(inc1.channelLabel === 'X displacement', `INC-2026-0001 display channel is '${inc1.channelLabel}'`);
    assert(inc1.quality === 'VALID', `INC-2026-0001 measurement quality is '${inc1.quality}'`);
    assert(inc1.health === 'H3', `INC-2026-0001 health is '${inc1.health}'`);
    assert(inc1.device?.deviceId === 'SNRS485-2026-0001',
      `Device relationship resolved via SensorDeviceMapping: ${inc1.device?.deviceId}`);
    assert(inc1.gateway?.gatewayId === 'GWLR-2026-0001',
      `Gateway relationship resolved via DeviceGatewayMapping: ${inc1.gateway?.gatewayId}`);

    // 5. Verify Instruments without active rules show NOT EVALUATED
    const inc2 = markers.find(m => m.code === 'INC-2026-0002');
    assert(Boolean(inc2), 'INC-2026-0002 present in response');
    assert(inc2.severity === 'NOT EVALUATED', `INC-2026-0002 severity is '${inc2.severity}' (Not evaluated)`);
    assert(Array.isArray(inc2.coordinates) && inc2.coordinates[0] === 70.66 && inc2.coordinates[1] === 34.55,
      `INC-2026-0002 coordinates [${inc2.coordinates}] match commissioning [70.66, 34.55]`);

    const pz1 = markers.find(m => m.code === 'PZVW-2026-0001');
    assert(Boolean(pz1), 'PZVW-2026-0001 present in response');
    assert(pz1.severity === 'NOT EVALUATED', `PZVW-2026-0001 severity is '${pz1.severity}' (Not evaluated)`);

    // 6. Verify Instruments without coordinates have null coordinates (not 0,0)
    const incl3 = markers.find(m => m.code === 'INCL-003');
    assert(Boolean(incl3), 'INCL-003 present in response');
    assert(incl3.coordinates === null, `INCL-003 has null coordinates (actual: ${incl3.coordinates})`);

    const incl4 = markers.find(m => m.code === 'INCL-004');
    assert(Boolean(incl4), 'INCL-004 present in response');
    assert(incl4.coordinates === null, `INCL-004 has null coordinates (actual: ${incl4.coordinates})`);

    // 7. Verify NO alarms created
    const finalAlarmCount = await Alarm.countDocuments();
    assert(finalAlarmCount === initialAlarmCount, `No alarms created during map operation (count: ${finalAlarmCount})`);

    // 8. Verify Project isolation: non-existent project returns 404 or 403
    const fakeId = new mongoose.Types.ObjectId();
    const badRes = await fetch(`${BASE_URL}/api/v1/projects/${fakeId}/map/instruments`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(badRes.status === 403 || badRes.status === 404, `Cross-project/invalid project rejected with ${badRes.status}`);

    console.log('\n====================================================');
    console.log('ALL PHASE C4 BACKEND VERIFICATIONS PASSED');
    console.log('====================================================');
  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC4Verification().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
