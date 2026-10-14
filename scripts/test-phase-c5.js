#!/usr/bin/env node

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  Alarm,
  User,
  OrganizationMember
} from '../src/models/index.js';

let server;
const TEST_PORT = 3109;
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

async function runC5Verification() {
  console.log('====================================================');
  console.log('PHASE C5 — PROJECT OVERVIEW OPERATIONAL VERIFICATION');
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

    // 3. Query GET /api/v1/projects/:projectId/overview
    const res = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/overview`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    assert(res.status === 200, `GET /overview returned HTTP 200 (actual: ${res.status})`);
    const data = await res.json();

    // 4. Validate Asset Summary
    assert(data.instruments?.total === 6, `instruments.total is 6 (got ${data.instruments?.total})`);
    assert(data.instruments?.positioned === 3, `instruments.positioned is 3 (got ${data.instruments?.positioned})`);
    assert(data.instruments?.unpositioned === 3, `instruments.unpositioned is 3 (got ${data.instruments?.unpositioned})`);
    assert(data.instruments?.noTelemetry === 3, `instruments.noTelemetry is 3 (got ${data.instruments?.noTelemetry})`);
    assert(data.devices?.total === 2, `devices.total is 2 (got ${data.devices?.total})`);
    assert(data.gateways?.total === 1, `gateways.total is 1 (got ${data.gateways?.total})`);

    // 5. Validate Engineering Severity
    assert(data.severity?.S0 === 0, `severity.S0 is 0 (got ${data.severity?.S0})`);
    assert(data.severity?.S1 === 1, `severity.S1 is 1 (got ${data.severity?.S1})`);
    assert(data.severity?.S2 === 0, `severity.S2 is 0 (got ${data.severity?.S2})`);
    assert(data.severity?.S3 === 0, `severity.S3 is 0 (got ${data.severity?.S3})`);
    assert(data.severity?.S4 === 0, `severity.S4 is 0 (got ${data.severity?.S4})`);
    assert(data.severity?.notEvaluated === 5, `severity.notEvaluated is 5 (got ${data.severity?.notEvaluated})`);

    // 6. Validate Monitoring Health
    assert(data.health?.H0 === 0, `health.H0 is 0 (got ${data.health?.H0})`);
    assert(data.health?.H1 === 0, `health.H1 is 0 (got ${data.health?.H1})`);
    assert(data.health?.H2 === 0, `health.H2 is 0 (got ${data.health?.H2})`);
    assert(data.health?.H3 === 6, `health.H3 is 6 (got ${data.health?.H3})`);
    assert(data.health?.unknown === 0, `health.unknown is 0 (got ${data.health?.unknown})`);

    // 7. Validate Measurement Quality
    assert(data.quality?.valid === 3, `quality.valid is 3 (got ${data.quality?.valid})`);
    assert(data.quality?.suspect === 0, `quality.suspect is 0 (got ${data.quality?.suspect})`);
    assert(data.quality?.invalid === 0, `quality.invalid is 0 (got ${data.quality?.invalid})`);
    assert(data.quality?.unavailable === 3, `quality.unavailable is 3 (got ${data.quality?.unavailable})`);

    // 8. Validate Device & Gateway Runtime
    assert(data.devices?.offline === 2, `devices.offline is 2 (got ${data.devices?.offline})`);
    assert(data.devices?.online === 0, `devices.online is 0 (got ${data.devices?.online})`);
    assert(data.gateways?.offline === 1, `gateways.offline is 1 (got ${data.gateways?.offline})`);
    assert(data.gateways?.online === 0, `gateways.online is 0 (got ${data.gateways?.online})`);

    // 9. Validate Operational Attention
    assert(Array.isArray(data.attention) && data.attention.length >= 3, `Operational attention items present (${data.attention?.length})`);
    const unposItem = data.attention.find(a => a.type === 'UNPOSITIONED_INSTRUMENTS');
    assert(Boolean(unposItem && unposItem.count === 3), 'Attention includes 3 instruments without coordinates');
    assert(unposItem.action === 'COMMISSIONING', 'Attention action for unpositioned instruments is COMMISSIONING');

    // 10. Alarm integrity: No alarms should be created or modified by overview
    const currentAlarmCount = await Alarm.countDocuments();
    assert(currentAlarmCount === initialAlarmCount, `No alarms created or mutated (initial: ${initialAlarmCount}, current: ${currentAlarmCount})`);

    // 11. Cross-project protection
    const fakeId = new mongoose.Types.ObjectId();
    const badRes = await fetch(`${BASE_URL}/api/v1/projects/${fakeId}/overview`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(badRes.status === 404 || badRes.status === 403, `Cross-project/invalid project rejected with 404/403 (actual: ${badRes.status})`);

    console.log('\n====================================================');
    console.log('ALL PHASE C5 BACKEND VERIFICATIONS PASSED');
    console.log('====================================================');
  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC5Verification().catch((err) => {
  console.error('[C5 TEST ERROR]', err);
  process.exit(1);
});
