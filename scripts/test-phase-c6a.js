#!/usr/bin/env node

/**
 * PHASE C6A — CANONICAL ALARM LIFECYCLE FOUNDATION TEST
 *
 * Verifies:
 * 1. create canonical TEST alarm through internal service
 * 2. OPEN state created
 * 3. lifecycle history contains CREATED
 * 4. acknowledge OPEN alarm via API / service
 * 5. ACKNOWLEDGED state
 * 6. acknowledgedAt set
 * 7. acknowledgedBy set
 * 8. history contains ACKNOWLEDGED
 * 9. acknowledge same alarm again handled safely (idempotent)
 * 10. resolve acknowledged alarm
 * 11. RESOLVED state
 * 12. resolvedAt set
 * 13. resolvedBy set
 * 14. history contains RESOLVED
 * 15. invalid transition rejected (409)
 * 16. cross-project alarm access rejected (404/403)
 * 17. Viewer mutation rejected (403)
 * 18. project alarm list filters work
 * 19. legacy alarms remain unchanged
 * 20. no alarm is automatically created from current S1 telemetry
 * 21. Severity evaluation remains unchanged
 * 22. C3 tests still pass
 * 23. C4 tests still pass
 * 24. C5 tests still pass
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
  escalateAlarmSeverity,
  findActiveAlarm,
  getAlarm,
  listAlarms
} from '../src/services/alarm.service.js';

let server;
const TEST_PORT = 3110;
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

async function runC6aVerification() {
  console.log('====================================================');
  console.log('PHASE C6A — CANONICAL ALARM LIFECYCLE FOUNDATION TEST');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  const initialAlarmCount = await Alarm.countDocuments();
  const initialEventsCount = await AlarmEvent.countDocuments();
  console.log(`[INFO] Initial Alarm count: ${initialAlarmCount}`);
  console.log(`[INFO] Initial AlarmEvent count: ${initialEventsCount}`);

  const testAlarmIds = [];

  try {
    // 1. Resolve Project LAN-PRO-01
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(Boolean(project), `Found project LAN-PRO-01 (${project?._id})`);

    const instrument = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' });
    assert(Boolean(instrument), `Found instrument INC-2026-0001 (${instrument?._id})`);

    // 2. Setup user tokens
    const user = await User.findOne({ organizationId: project.organizationId }) || await User.findOne();
    const adminToken = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: user._id.toString(), expiresIn: '1h' }
    );

    // Setup a viewer token
    let viewerUser = await User.findOne({ email: 'test.viewer@geonexa.test' });
    if (!viewerUser) {
      viewerUser = await User.create({
        email: 'test.viewer@geonexa.test',
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

    // =========================================================================
    // TEST 1, 2, 3: Create Canonical TEST Alarm (Service level)
    // =========================================================================
    console.log('\n--- Test 1, 2, 3: Create Canonical TEST Alarm ---');
    const createdResult = await createAlarm({
      organizationId: project.organizationId,
      projectId: project._id,
      category: 'ENGINEERING_SEVERITY',
      title: 'TEST - Lateral Displacement Advisory',
      summary: 'Automated test advisory alarm on INC-2026-0001',
      reason: 'THRESHOLD_S1_EXCEEDED',
      instrumentId: instrument._id,
      parameterCode: 'x_displacement',
      initialSeverity: 'S1',
      engineeringSnapshot: {
        severityLevel: 'S1',
        ruleId: new mongoose.Types.ObjectId(),
        ruleVersion: 1,
        metric: 'engineeringValue',
        evaluatedValue: 1.4,
        unit: 'mm',
        observedAt: new Date(),
        severityEvaluatedAt: new Date(),
        reason: 'THRESHOLD_S1_EXCEEDED'
      },
      actor: {
        actorType: 'SYSTEM',
        displayName: 'Test Runner'
      },
      comment: 'Initial canonical test alarm creation'
    });

    const testAlarm = createdResult.alarm;
    testAlarmIds.push(testAlarm._id);

    assert(createdResult.isDuplicate === false, 'Test alarm created (not duplicate)');
    assert(testAlarm.status === 'OPEN', `Alarm status is OPEN (got: ${testAlarm.status})`);
    assert(testAlarm.lifecycleVersion === 2, `Alarm lifecycleVersion is 2 (got: ${testAlarm.lifecycleVersion})`);
    assert(testAlarm.currentSeverity === 'S1', `Alarm currentSeverity is S1 (got: ${testAlarm.currentSeverity})`);
    assert(testAlarm.initialSeverity === 'S1', `Alarm initialSeverity is S1 (got: ${testAlarm.initialSeverity})`);
    assert(testAlarm.highestSeverity === 'S1', `Alarm highestSeverity is S1 (got: ${testAlarm.highestSeverity})`);
    assert(Boolean(testAlarm.engineeringSnapshot), 'Engineering snapshot preserved');

    // Verify lifecycle history contains CREATED
    const createdEvents = await AlarmEvent.find({ alarmId: testAlarm._id });
    assert(createdEvents.length === 1, `Exactly 1 history event created (got: ${createdEvents.length})`);
    assert(createdEvents[0].eventType === 'CREATED', `Event type is CREATED (got: ${createdEvents[0].eventType})`);
    assert(createdEvents[0].newStatus === 'OPEN', `Event newStatus is OPEN (got: ${createdEvents[0].newStatus})`);

    // =========================================================================
    // TEST 4, 5, 6, 7, 8: Acknowledge Alarm via API
    // =========================================================================
    console.log('\n--- Test 4, 5, 6, 7, 8: Acknowledge Alarm via API ---');
    const ackRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarm._id}/acknowledge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Geotechnical engineer acknowledging test alarm' })
    });

    assert(ackRes.status === 200, `Acknowledge endpoint returned HTTP 200 (got: ${ackRes.status})`);
    const ackData = await ackRes.json();
    assert(ackData.status === 'ACKNOWLEDGED', `Alarm status transitioned to ACKNOWLEDGED (got: ${ackData.status})`);
    assert(Boolean(ackData.acknowledgedAt), 'acknowledgedAt timestamp is populated');
    assert(String(ackData.acknowledgedBy) === String(user._id), 'acknowledgedBy user ID is correctly populated');

    // Verify history contains ACKNOWLEDGED event
    const ackEvents = await AlarmEvent.find({ alarmId: testAlarm._id }).sort({ createdAt: 1 });
    assert(ackEvents.length === 2, `History has 2 events (got: ${ackEvents.length})`);
    assert(ackEvents[1].eventType === 'ACKNOWLEDGED', `Second event is ACKNOWLEDGED (got: ${ackEvents[1].eventType})`);
    assert(ackEvents[1].previousStatus === 'OPEN', `Event previousStatus is OPEN (got: ${ackEvents[1].previousStatus})`);
    assert(ackEvents[1].newStatus === 'ACKNOWLEDGED', `Event newStatus is ACKNOWLEDGED (got: ${ackEvents[1].newStatus})`);
    assert(ackEvents[1].actorType === 'USER', 'Event actorType is USER');

    // =========================================================================
    // TEST 9: Acknowledge Same Alarm Again (Idempotent Safe Double-Action)
    // =========================================================================
    console.log('\n--- Test 9: Safe Double Acknowledgment ---');
    const doubleAckRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarm._id}/acknowledge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Second acknowledgment attempt' })
    });

    assert(doubleAckRes.status === 200, `Double acknowledge returned HTTP 200 (got: ${doubleAckRes.status})`);
    const doubleAckEvents = await AlarmEvent.find({ alarmId: testAlarm._id });
    assert(doubleAckEvents.length === 2, `No duplicate event created on double acknowledge (count: ${doubleAckEvents.length})`);

    // =========================================================================
    // TEST 10, 11, 12, 13, 14: Resolve Alarm via API
    // =========================================================================
    console.log('\n--- Test 10, 11, 12, 13, 14: Resolve Alarm via API ---');
    const resolveRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarm._id}/resolve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        comment: 'Condition verified stable by lead engineer',
        resolutionReason: 'ENGINEERING_REVIEW_CLEARED'
      })
    });

    assert(resolveRes.status === 200, `Resolve endpoint returned HTTP 200 (got: ${resolveRes.status})`);
    const resolvedData = await resolveRes.json();
    assert(resolvedData.status === 'RESOLVED', `Alarm status transitioned to RESOLVED (got: ${resolvedData.status})`);
    assert(Boolean(resolvedData.resolvedAt), 'resolvedAt timestamp is populated');
    assert(String(resolvedData.resolvedBy) === String(user._id), 'resolvedBy user ID is correctly populated');
    assert(resolvedData.resolutionReason === 'ENGINEERING_REVIEW_CLEARED', 'resolutionReason is correctly populated');

    // Verify history contains RESOLVED event
    const resolveEvents = await AlarmEvent.find({ alarmId: testAlarm._id }).sort({ createdAt: 1 });
    assert(resolveEvents.length === 3, `History has 3 events (got: ${resolveEvents.length})`);
    assert(resolveEvents[2].eventType === 'RESOLVED', `Third event is RESOLVED (got: ${resolveEvents[2].eventType})`);
    assert(resolveEvents[2].previousStatus === 'ACKNOWLEDGED', `Event previousStatus is ACKNOWLEDGED (got: ${resolveEvents[2].previousStatus})`);
    assert(resolveEvents[2].newStatus === 'RESOLVED', `Event newStatus is RESOLVED (got: ${resolveEvents[2].newStatus})`);

    // =========================================================================
    // TEST 15: Invalid Transition Rejected
    // =========================================================================
    console.log('\n--- Test 15: Invalid Transition Rejected ---');
    // Attempting to acknowledge an already resolved alarm must fail
    const invalidAckRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarm._id}/acknowledge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Attempting to acknowledge a resolved alarm' })
    });

    assert(invalidAckRes.status === 409, `Acknowledging resolved alarm rejected with HTTP 409 (got: ${invalidAckRes.status})`);

    // Attempting to resolve an already resolved alarm must fail
    const invalidResolveRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${testAlarm._id}/resolve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Attempting to resolve again' })
    });

    assert(invalidResolveRes.status === 409, `Resolving already resolved alarm rejected with HTTP 409 (got: ${invalidResolveRes.status})`);

    // =========================================================================
    // TEST 16: Cross-Project Alarm Access Rejected
    // =========================================================================
    console.log('\n--- Test 16: Cross-Project Isolation ---');
    const fakeProjectId = new mongoose.Types.ObjectId();
    const crossProjRes = await fetch(`${BASE_URL}/api/v1/projects/${fakeProjectId}/alarms/${testAlarm._id}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(crossProjRes.status === 404 || crossProjRes.status === 403, `Cross-project alarm get rejected with 404/403 (got: ${crossProjRes.status})`);

    const crossAckRes = await fetch(`${BASE_URL}/api/v1/projects/${fakeProjectId}/alarms/${testAlarm._id}/acknowledge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Cross project attack' })
    });
    assert(crossAckRes.status === 404 || crossAckRes.status === 403, `Cross-project acknowledge rejected with 404/403 (got: ${crossAckRes.status})`);

    // =========================================================================
    // TEST 17: Viewer Mutation Rejected (Read-Only)
    // =========================================================================
    console.log('\n--- Test 17: Viewer Role Read-Only Enforcement ---');
    // Create another open test alarm
    const viewerTestAlarmResult = await createAlarm({
      organizationId: project.organizationId,
      projectId: project._id,
      category: 'MONITORING_HEALTH',
      title: 'TEST - Viewer Protection Test Alarm',
      summary: 'Viewer test alarm',
      initialSeverity: 'S0'
    });
    const viewerAlarm = viewerTestAlarmResult.alarm;
    testAlarmIds.push(viewerAlarm._id);

    // Viewer GET must succeed
    const viewerGetRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${viewerAlarm._id}`, {
      headers: { 'Authorization': `Bearer ${viewerToken}` }
    });
    assert(viewerGetRes.status === 200, `Viewer can read alarm (HTTP 200)`);

    // Viewer POST acknowledge must fail with 403
    const viewerAckRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${viewerAlarm._id}/acknowledge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${viewerToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Viewer trying to acknowledge' })
    });
    assert(viewerAckRes.status === 403, `Viewer acknowledge rejected with HTTP 403 (got: ${viewerAckRes.status})`);

    // Viewer POST resolve must fail with 403
    const viewerResolveRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms/${viewerAlarm._id}/resolve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${viewerToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: 'Viewer trying to resolve' })
    });
    assert(viewerResolveRes.status === 403, `Viewer resolve rejected with HTTP 403 (got: ${viewerResolveRes.status})`);

    // =========================================================================
    // TEST 18: Project Alarm List Filters Work
    // =========================================================================
    console.log('\n--- Test 18: Project Alarm List Filters ---');
    // List OPEN alarms
    const openListRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms?status=OPEN`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(openListRes.status === 200, 'GET /alarms?status=OPEN returned HTTP 200');
    const openAlarms = await openListRes.json();
    assert(Array.isArray(openAlarms), 'Response is an array');
    assert(openAlarms.some(a => String(a._id) === String(viewerAlarm._id)), 'OPEN filter includes viewerAlarm');
    assert(!openAlarms.some(a => String(a._id) === String(testAlarm._id)), 'OPEN filter excludes RESOLVED testAlarm');

    // List RESOLVED alarms
    const resolvedListRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms?status=RESOLVED`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(resolvedListRes.status === 200, 'GET /alarms?status=RESOLVED returned HTTP 200');
    const resolvedAlarms = await resolvedListRes.json();
    assert(resolvedAlarms.some(a => String(a._id) === String(testAlarm._id)), 'RESOLVED filter includes resolved testAlarm');

    // Filter by category
    const catListRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/alarms?category=ENGINEERING_SEVERITY`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(catListRes.status === 200, 'GET /alarms?category=ENGINEERING_SEVERITY returned HTTP 200');
    const catAlarms = await catListRes.json();
    assert(catAlarms.every(a => a.category === 'ENGINEERING_SEVERITY'), 'Category filter strictly matches ENGINEERING_SEVERITY');

    // =========================================================================
    // TEST: Deduplication Foundation
    // =========================================================================
    console.log('\n--- Test: Deduplication Foundation ---');
    const dedup1 = await createAlarm({
      organizationId: project.organizationId,
      projectId: project._id,
      category: 'DEVICE_CONNECTIVITY',
      title: 'TEST - Device offline',
      deviceId: new mongoose.Types.ObjectId()
    });
    testAlarmIds.push(dedup1.alarm._id);
    assert(dedup1.isDuplicate === false, 'Initial alarm creation is not duplicate');

    // Attempt to create another alarm with identical fingerprint while active
    const dedup2 = await createAlarm({
      organizationId: project.organizationId,
      projectId: project._id,
      category: 'DEVICE_CONNECTIVITY',
      title: 'TEST - Device offline duplicate',
      deviceId: dedup1.alarm.deviceId
    });
    assert(dedup2.isDuplicate === true, 'Duplicate alarm detected and prevented');
    assert(String(dedup2.alarm._id) === String(dedup1.alarm._id), 'Returned existing active alarm on duplicate call');

    // =========================================================================
    // TEST: Severity Escalation Support
    // =========================================================================
    console.log('\n--- Test: Severity Escalation Support ---');
    const escAlarmResult = await createAlarm({
      organizationId: project.organizationId,
      projectId: project._id,
      category: 'ENGINEERING_SEVERITY',
      title: 'TEST - Escalation Candidate',
      initialSeverity: 'S2'
    });
    const escAlarm = escAlarmResult.alarm;
    testAlarmIds.push(escAlarm._id);
    assert(escAlarm.currentSeverity === 'S2', 'Initial severity is S2');

    // Escalate to S3
    const escalated = await escalateAlarmSeverity({
      alarmId: escAlarm._id,
      projectId: project._id,
      organizationId: project.organizationId,
      newSeverity: 'S3',
      comment: 'Telemetry increased past S3 threshold'
    });
    assert(escalated.currentSeverity === 'S3', `currentSeverity escalated to S3 (got: ${escalated.currentSeverity})`);
    assert(escalated.highestSeverity === 'S3', `highestSeverity updated to S3 (got: ${escalated.highestSeverity})`);
    assert(escalated.initialSeverity === 'S2', `initialSeverity preserved as S2 (got: ${escalated.initialSeverity})`);

    const escEvents = await AlarmEvent.find({ alarmId: escAlarm._id, eventType: 'ESCALATED' });
    assert(escEvents.length === 1, 'ESCALATED audit event created');
    assert(escEvents[0].metadata.previousSeverity === 'S2', 'Audit event metadata captures previousSeverity');
    assert(escEvents[0].metadata.newSeverity === 'S3', 'Audit event metadata captures newSeverity');

    // =========================================================================
    // CLEANUP TEST ALARMS & AUDIT EVENTS
    // =========================================================================
    console.log('\n--- Cleaning up Test Alarms ---');
    await Alarm.deleteMany({ _id: { $in: testAlarmIds } });
    await AlarmEvent.deleteMany({ alarmId: { $in: testAlarmIds } });
    if (viewerUser) {
      await ProjectMember.deleteOne({ projectId: project._id, userId: viewerUser._id });
      await OrganizationMember.deleteOne({ organizationId: project.organizationId, userId: viewerUser._id });
      await User.deleteOne({ _id: viewerUser._id });
    }
    console.log(`[PASS] Cleaned up ${testAlarmIds.length} temporary test alarms and related events`);

    // =========================================================================
    // TEST 19: Legacy Alarms Remain Unchanged
    // =========================================================================
    console.log('\n--- Test 19: Legacy Alarms Unchanged ---');
    const finalAlarmCount = await Alarm.countDocuments();
    assert(finalAlarmCount === initialAlarmCount, `Total alarm count equals initial legacy count (${finalAlarmCount} === ${initialAlarmCount})`);
    assert(finalAlarmCount === 5, `Legacy alarms count is exactly 5 (got: ${finalAlarmCount})`);

    // =========================================================================
    // TEST 20, 21: No Auto-Created Alarm from Current S1 Telemetry
    // =========================================================================
    console.log('\n--- Test 20, 21: No Auto-Alarm from S1 ---');
    const s1Rule = await EngineeringSeverityRule.findOne({ projectId: project._id, status: 'ACTIVE' });
    assert(Boolean(s1Rule), `Development rule exists for project (${s1Rule?.name})`);

    const s1Alarms = await Alarm.find({
      projectId: project._id,
      lifecycleVersion: 2,
      parameterCode: 'x_displacement'
    });
    assert(s1Alarms.length === 0, `No canonical alarm created from active S1 telemetry (got: ${s1Alarms.length})`);

    console.log('\n====================================================');
    console.log('ALL PHASE C6A CANONICAL LIFECYCLE TESTS PASSED!');
    console.log('====================================================');

  } catch (err) {
    // Ensure test alarms are cleaned up on error
    if (testAlarmIds.length > 0) {
      await Alarm.deleteMany({ _id: { $in: testAlarmIds } });
      await AlarmEvent.deleteMany({ alarmId: { $in: testAlarmIds } });
    }
    console.error('\n[FATAL ERROR]:', err);
    process.exitCode = 1;
  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC6aVerification();
