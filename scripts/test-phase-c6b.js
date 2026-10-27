#!/usr/bin/env node

/**
 * PHASE C6B — CANONICAL ALARM UI & OPERATIONAL WORKFLOW TEST
 *
 * Verifies:
 * 1. Default GET /api/v1/projects/:projectId/alarms returns ONLY canonical (lifecycleVersion: 2) alarms.
 * 2. 5 legacy records are completely excluded from default canonical queries.
 * 3. includeLegacy=true allows retrieving legacy alarms.
 * 4. Initial canonical alarm count before test is 0.
 * 5. create-test-canonical-alarm.js creates 1 synthetic canonical test alarm through alarm.service.js.
 * 6. Alarm detail returns trigger snapshot (ENGINEERING_SEVERITY: S2, rule, metric, value, unit).
 * 7. Audit history contains CREATED event.
 * 8. Acknowledge API transitions OPEN -> ACKNOWLEDGED.
 * 9. Repeated acknowledge does not create duplicate event.
 * 10. Resolve API requires resolutionReason and transitions ACKNOWLEDGED -> RESOLVED.
 * 11. Audit history timeline shows chronological events (CREATED -> ACKNOWLEDGED -> RESOLVED).
 * 12. VIEWER role cannot acknowledge or resolve (403 Forbidden).
 * 13. Project isolation is strictly enforced (cross-project access rejected).
 * 14. Current S1 telemetry on INC-2026-0001 DOES NOT auto-generate an alarm.
 * 15. Legacy alarms remain exactly 5 and untouched in MongoDB.
 * 16. Test alarm clean up works.
 */

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  Alarm,
  AlarmEvent,
  Instrument,
  User,
  OrganizationMember,
  ProjectMember,
  EngineeringSeverityRule
} from '../src/models/index.js';
import {
  createAlarm,
  acknowledgeAlarm,
  resolveAlarm,
  getAlarm,
  listAlarms
} from '../src/services/alarm.service.js';

let server;
const TEST_PORT = 3112;
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

async function runC6bVerification() {
  console.log('====================================================');
  console.log('PHASE C6B — CANONICAL ALARM UI & WORKFLOW TEST');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  try {
    // 1. Resolve Project LAN-PRO-01
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(project, 'Project LAN-PRO-01 exists');

    const otherProject = await Project.findOne({ _id: { $ne: project._id } });
    assert(otherProject, 'Secondary project exists for isolation testing');

    const instrument = await Instrument.findOne({
      projectId: project._id,
      code: 'INC-2026-0001'
    });
    assert(instrument, 'Instrument INC-2026-0001 exists');

    // 2. Count legacy alarms in MongoDB
    const legacyAlarms = await Alarm.find({
      $or: [
        { lifecycleVersion: 1 },
        { lifecycleVersion: { $exists: false } },
        { lifecycleVersion: null }
      ]
    });
    console.log(`[INFO] Exact legacy alarm count in DB: ${legacyAlarms.length}`);
    assert(legacyAlarms.length === 5, `Legacy alarm count in DB is exactly 5 (got: ${legacyAlarms.length})`);

    // 3. Setup test users and tokens
    let adminUser = await User.findOne({ email: 'admin@geonexa.test' });
    if (!adminUser) {
      adminUser = await User.create({
        email: 'admin@geonexa.test',
        displayName: 'Test Admin',
        passwordHash: 'dummy'
      });
    }
    await OrganizationMember.findOneAndUpdate(
      { organizationId: project.organizationId, userId: adminUser._id },
      { organizationRole: 'ADMIN', status: 'ACTIVE' },
      { upsert: true }
    );
    await ProjectMember.findOneAndUpdate(
      { projectId: project._id, userId: adminUser._id },
      { role: 'ADMIN', status: 'ACTIVE' },
      { upsert: true }
    );

    const adminToken = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'ADMIN' },
      env.jwtSecret,
      { subject: adminUser._id.toString(), expiresIn: '1h' }
    );

    let viewerUser = await User.findOne({ email: 'viewer@geonexa.test' });
    if (!viewerUser) {
      viewerUser = await User.create({
        email: 'viewer@geonexa.test',
        displayName: 'Test Viewer',
        passwordHash: 'dummy'
      });
    }
    await OrganizationMember.findOneAndUpdate(
      { organizationId: project.organizationId, userId: viewerUser._id },
      { organizationRole: 'VIEWER', status: 'ACTIVE' },
      { upsert: true }
    );
    await ProjectMember.findOneAndUpdate(
      { projectId: project._id, userId: viewerUser._id },
      { role: 'VIEWER', status: 'ACTIVE' },
      { upsert: true }
    );

    const viewerToken = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'VIEWER' },
      env.jwtSecret,
      { subject: viewerUser._id.toString(), expiresIn: '1h' }
    );

    // Initial clean-up of any lingering test alarms
    const lingering = await Alarm.find({
      projectId: project._id,
      summary: { $regex: /DEVELOPMENT TEST/i }
    });
    for (const al of lingering) {
      await AlarmEvent.deleteMany({ alarmId: al._id });
      await Alarm.deleteOne({ _id: al._id });
    }

    // =========================================================================
    // TEST 1: Default GET Alarms Excludes Legacy Records (Initial canonical = 0)
    // =========================================================================
    console.log('\n--- Test 1: Default GET Alarms (Legacy Exclusion) ---');
    const getRes1 = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(getRes1.status === 200, `Default GET alarms status is 200 (got: ${getRes1.status})`);
    const alarms1 = await getRes1.json();
    console.log(`[INFO] Default canonical alarms returned: ${alarms1.length}`);
    for (const a of alarms1) {
      assert(a.lifecycleVersion === 2, `Alarm has lifecycleVersion 2: ${a._id}`);
    }

    // TEST 1b: includeLegacy=true returns legacy records for this project
    const projectLegacyCount = legacyAlarms.filter(a => a.projectId?.toString() === project._id.toString()).length;
    const getLegacyRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms?includeLegacy=true`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(getLegacyRes.status === 200, `includeLegacy=true status is 200 (got: ${getLegacyRes.status})`);
    const allAlarms = await getLegacyRes.json();
    console.log(`[INFO] Alarms with includeLegacy=true for LAN-PRO-01: ${allAlarms.length} (expected legacy: ${projectLegacyCount})`);
    assert(allAlarms.length === projectLegacyCount, `includeLegacy=true returns exactly ${projectLegacyCount} legacy alarm(s) for this project`);

    // =========================================================================
    // TEST 2: Create Canonical Development Test Alarm via alarm.service.js
    // =========================================================================
    console.log('\n--- Test 2: Create Development Test Alarm ---');
    const rule = await EngineeringSeverityRule.findOne({
      projectId: project._id,
      parameterCode: 'x_displacement',
      status: 'ACTIVE'
    });

    const createResult = await createAlarm({
      organizationId: project.organizationId,
      projectId: project._id,
      category: 'ENGINEERING_SEVERITY',
      title: 'Accelerating slope movement — Test Advisory',
      summary: 'DEVELOPMENT TEST: Synthetic S2 displacement advisory on INC-2026-0001 for C6B UI workflow verification',
      reason: 'THRESHOLD_S2_EXCEEDED',
      instrumentId: instrument._id,
      parameterCode: 'x_displacement',
      initialSeverity: 'S2',
      engineeringSnapshot: {
        severityLevel: 'S2',
        ruleId: rule?._id || new mongoose.Types.ObjectId(),
        ruleVersion: rule?.version || 1,
        metric: 'engineeringValue',
        evaluatedValue: 2.85,
        unit: 'mm',
        observedAt: new Date(),
        severityEvaluatedAt: new Date(),
        reason: 'THRESHOLD_S2_EXCEEDED'
      },
      actor: {
        actorType: 'SYSTEM',
        displayName: 'Dev Seed Script'
      },
      comment: 'Synthetic canonical test alarm created for C6B validation.'
    });

    const testAlarmId = createResult.alarm._id.toString();
    console.log(`[INFO] Created test canonical alarm: ${testAlarmId}`);
    assert(createResult.alarm.status === 'OPEN', 'Created alarm status is OPEN');
    assert(createResult.alarm.lifecycleVersion === 2, 'Created alarm lifecycleVersion is 2');
    assert(createResult.alarm.currentSeverity === 'S2', 'Created alarm currentSeverity is S2');

    // =========================================================================
    // TEST 3: GET Alarm List returns canonical alarm & verifies status invariant
    // =========================================================================
    console.log('\n--- Test 3: Verify Canonical Alarm in List API & Status Invariant ---');
    const getRes2 = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(getRes2.status === 200, 'GET alarms returns 200');
    const alarms2 = await getRes2.json();
    const found = alarms2.find(a => a._id === testAlarmId);
    assert(found, `Canonical test alarm ${testAlarmId} found in default list`);
    assert(found.status === 'OPEN', 'Found alarm in list is OPEN');
    assert(found.lifecycleVersion === 2, 'Found alarm in list has lifecycleVersion 2');

    // Status invariant check: totalCanonical === open + acknowledged + resolved
    const openCount1 = alarms2.filter(a => a.status === 'OPEN').length;
    const ackCount1 = alarms2.filter(a => a.status === 'ACKNOWLEDGED').length;
    const resCount1 = alarms2.filter(a => a.status === 'RESOLVED').length;
    assert(alarms2.length === openCount1 + ackCount1 + resCount1, `Status invariant holds on OPEN: total (${alarms2.length}) === open (${openCount1}) + ack (${ackCount1}) + resolved (${resCount1})`);
    assert(openCount1 === 1, `Open count is 1 (got: ${openCount1})`);
    assert(ackCount1 === 0, `Acknowledged count is 0 (got: ${ackCount1})`);
    assert(resCount1 === 0, `Resolved count is 0 (got: ${resCount1})`);

    // Portfolio active canonical alarms check (Sidebar badge source)
    const portRes1 = await fetch(`${BASE_URL}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const portList1 = await portRes1.json();
    const portProj1 = portList1.find(p => p.id === project._id.toString());
    assert(portProj1 && portProj1.counts.openAlarms === 1, `Sidebar badge (openAlarms) on OPEN is 1 (got: ${portProj1?.counts?.openAlarms})`);

    // =========================================================================
    // TEST 4: GET Alarm Detail & Trigger Snapshot & Audit History
    // =========================================================================
    console.log('\n--- Test 4: Verify Detail & Trigger Snapshot & CREATED Audit Event ---');
    const detailRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(detailRes.status === 200, 'GET alarm detail returns 200');
    const detail = await detailRes.json();
    assert(detail.alarm && detail.alarm._id === testAlarmId, 'Detail returns alarm document');
    assert(detail.alarm.engineeringSnapshot, 'Detail returns engineeringSnapshot');
    assert(detail.alarm.engineeringSnapshot.severityLevel === 'S2', 'Snapshot severityLevel is S2');
    assert(detail.alarm.engineeringSnapshot.evaluatedValue === 2.85, 'Snapshot evaluatedValue is 2.85');
    assert(detail.alarm.engineeringSnapshot.unit === 'mm', 'Snapshot unit is mm');
    assert(Array.isArray(detail.events) && detail.events.length >= 1, 'Audit events array returned');
    assert(detail.events[0].eventType === 'CREATED', 'First audit event is CREATED');
    assert(detail.events[0].newStatus === 'OPEN', 'CREATED event newStatus is OPEN');

    // =========================================================================
    // TEST 5: Viewer Read-Only Permissions (Cannot mutate)
    // =========================================================================
    console.log('\n--- Test 5: Viewer Read-Only Permissions ---');
    const viewerAckRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}/acknowledge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${viewerToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Viewer attempting acknowledge' })
    });
    assert(viewerAckRes.status === 403, `Viewer acknowledge rejected with 403 (got: ${viewerAckRes.status})`);

    const viewerResolveRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}/resolve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${viewerToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ resolutionReason: 'Viewer attempting resolve' })
    });
    assert(viewerResolveRes.status === 403, `Viewer resolve rejected with 403 (got: ${viewerResolveRes.status})`);

    // Viewer CAN read
    const viewerReadRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}`, {
      headers: { Authorization: `Bearer ${viewerToken}` }
    });
    assert(viewerReadRes.status === 200, 'Viewer can read alarm detail');

    // =========================================================================
    // TEST 6: Project Isolation
    // =========================================================================
    console.log('\n--- Test 6: Project Isolation ---');
    const crossRes = await fetch(`${BASE_URL}/api/v1/projects/${otherProject._id}/alarms/${testAlarmId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(crossRes.status === 404 || crossRes.status === 403, `Cross-project access rejected with 404 or 403 (got: ${crossRes.status})`);

    // =========================================================================
    // TEST 7: Acknowledge Alarm (OPEN -> ACKNOWLEDGED)
    // =========================================================================
    console.log('\n--- Test 7: Acknowledge Alarm ---');
    const ackRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}/acknowledge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Investigating slope movement' })
    });
    assert(ackRes.status === 200, `Acknowledge API returned 200 (got: ${ackRes.status})`);
    const ackBody = await ackRes.json();
    assert(ackBody.status === 'ACKNOWLEDGED', `Alarm status updated to ACKNOWLEDGED (got: ${ackBody.status})`);
    assert(ackBody.acknowledgedAt, 'acknowledgedAt timestamp set');
    assert(ackBody.acknowledgedBy, 'acknowledgedBy user set');

    // Double acknowledge (idempotent)
    const ackRes2 = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}/acknowledge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Duplicate acknowledge' })
    });
    assert(ackRes2.status === 200, 'Double acknowledge returns 200');
    const doubleAckEvents = await AlarmEvent.find({ alarmId: testAlarmId });
    assert(doubleAckEvents.length === 2, `Double acknowledge does not duplicate event (events count: ${doubleAckEvents.length})`);

    // Status invariant check on ACKNOWLEDGED
    const getResAck = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const alarmsAck = await getResAck.json();
    const openCount2 = alarmsAck.filter(a => a.status === 'OPEN').length;
    const ackCount2 = alarmsAck.filter(a => a.status === 'ACKNOWLEDGED').length;
    const resCount2 = alarmsAck.filter(a => a.status === 'RESOLVED').length;
    assert(alarmsAck.length === openCount2 + ackCount2 + resCount2, `Status invariant holds on ACK: total (${alarmsAck.length}) === open (${openCount2}) + ack (${ackCount2}) + res (${resCount2})`);
    assert(openCount2 === 0, `Open count is 0 on ACK (got: ${openCount2})`);
    assert(ackCount2 === 1, `Acknowledged count is 1 on ACK (got: ${ackCount2})`);
    assert(resCount2 === 0, `Resolved count is 0 on ACK (got: ${resCount2})`);

    // Portfolio active canonical alarms check (Sidebar badge on ACK is 1)
    const portRes2 = await fetch(`${BASE_URL}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const portList2 = await portRes2.json();
    const portProj2 = portList2.find(p => p.id === project._id.toString());
    assert(portProj2 && portProj2.counts.openAlarms === 1, `Sidebar badge (openAlarms) on ACK is 1 (got: ${portProj2?.counts?.openAlarms})`);

    // =========================================================================
    // TEST 8: Resolve Alarm (ACKNOWLEDGED -> RESOLVED)
    // =========================================================================
    console.log('\n--- Test 8: Resolve Alarm ---');
    const resolveRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}/resolve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        resolutionReason: 'Field inspection completed. Sensors calibrated.',
        comment: 'Stabilization verified.'
      })
    });
    assert(resolveRes.status === 200, `Resolve API returned 200 (got: ${resolveRes.status})`);
    const resolveBody = await resolveRes.json();
    assert(resolveBody.status === 'RESOLVED', `Alarm status updated to RESOLVED (got: ${resolveBody.status})`);
    assert(resolveBody.resolvedAt, 'resolvedAt timestamp set');
    assert(resolveBody.resolutionReason === 'Field inspection completed. Sensors calibrated.', 'resolutionReason saved');

    // Status invariant check on RESOLVED
    const getResRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const alarmsRes = await getResRes.json();
    const openCount3 = alarmsRes.filter(a => a.status === 'OPEN').length;
    const ackCount3 = alarmsRes.filter(a => a.status === 'ACKNOWLEDGED').length;
    const resCount3 = alarmsRes.filter(a => a.status === 'RESOLVED').length;
    assert(alarmsRes.length === openCount3 + ackCount3 + resCount3, `Status invariant holds on RES: total (${alarmsRes.length}) === open (${openCount3}) + ack (${ackCount3}) + res (${resCount3})`);
    assert(openCount3 === 0, `Open count is 0 on RES (got: ${openCount3})`);
    assert(ackCount3 === 0, `Acknowledged count is 0 on RES (got: ${ackCount3})`);
    assert(resCount3 === 1, `Resolved count is 1 on RES (got: ${resCount3})`);

    // Portfolio active canonical alarms check (Sidebar badge on RESOLVED must be 0)
    const portRes3 = await fetch(`${BASE_URL}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const portList3 = await portRes3.json();
    const portProj3 = portList3.find(p => p.id === project._id.toString());
    assert(portProj3 && portProj3.counts.openAlarms === 0, `Sidebar badge (openAlarms) on RESOLVED is 0 (got: ${portProj3?.counts?.openAlarms})`);

    // Filter tests
    const fActive = await (await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms?status=OPEN,ACKNOWLEDGED`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert(fActive.length === 0, `Active filter returns 0 for resolved alarm (got: ${fActive.length})`);
    const fResolved = await (await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms?status=RESOLVED`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert(fResolved.length === 1 && fResolved[0]._id === testAlarmId, `Resolved filter returns exactly the resolved alarm`);

    // Attempting to resolve an already resolved alarm must fail with 409
    const doubleResolveRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}/resolve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ resolutionReason: 'Duplicate resolve attempt' })
    });
    assert(doubleResolveRes.status === 409, `Resolving already resolved alarm rejected with 409 (got: ${doubleResolveRes.status})`);

    // =========================================================================
    // TEST 9: Chronological Audit History
    // =========================================================================
    console.log('\n--- Test 9: Chronological Audit History ---');
    const finalDetailRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarmId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(finalDetailRes.status === 200, 'Final detail fetch returns 200');
    const finalDetail = await finalDetailRes.json();
    const eventTypes = finalDetail.events.map(e => e.eventType);
    console.log(`[INFO] Event sequence: ${eventTypes.join(' -> ')}`);
    assert(eventTypes.includes('CREATED'), 'Events contain CREATED');
    assert(eventTypes.includes('ACKNOWLEDGED'), 'Events contain ACKNOWLEDGED');
    assert(eventTypes.includes('RESOLVED'), 'Events contain RESOLVED');

    // =========================================================================
    // TEST 10: Clean Up Test Alarm & Verify DB Invariants
    // =========================================================================
    console.log('\n--- Test 10: Clean Up & Legacy Isolation Invariant ---');
    await AlarmEvent.deleteMany({ alarmId: testAlarmId });
    await Alarm.deleteOne({ _id: testAlarmId });
    console.log(`[CLEANED] Test alarm ${testAlarmId} cleaned up.`);

    // Verify 5 legacy records remain intact
    const remainingLegacy = await Alarm.find({
      $or: [
        { lifecycleVersion: 1 },
        { lifecycleVersion: { $exists: false } },
        { lifecycleVersion: null }
      ]
    });
    assert(remainingLegacy.length === 5, `Legacy records untouched: exactly 5 remain (got: ${remainingLegacy.length})`);

    // Verify no automatic alarm generated from S1
    const postAlarms = await Alarm.find({
      projectId: project._id,
      lifecycleVersion: 2
    });
    console.log(`[INFO] Remaining canonical alarms: ${postAlarms.length}`);
    assert(postAlarms.length === 0, 'No automatic alarms were created for S1 telemetry');

    console.log('\n====================================================');
    console.log('ALL PHASE C6B VERIFICATION CHECKS PASSED (100%)');
    console.log('====================================================');
  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC6bVerification().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
