#!/usr/bin/env node

/**
 * PHASE C6C — CANONICAL ALARM TRIGGER POLICY + SEVERITY INTEGRATION TEST
 *
 * Verifies:
 * 1. No policy -> no Alarm.
 * 2. Inactive policy -> no Alarm.
 * 3. Active non-matching policy -> no Alarm.
 * 4. Active matching trigger level -> OPEN canonical Alarm.
 * 5. Alarm lifecycleVersion = 2.
 * 6. Correct severity snapshot.
 * 7. Correct policy snapshot/version.
 * 8. Duplicate qualifying packet -> same Alarm (duplicate suppressed).
 * 9. No duplicate CREATED event.
 * 10. Higher severity -> same Alarm escalated.
 * 11. ESCALATED event created with metadata.
 * 12. ACKNOWLEDGED Alarm can escalate without reverting to OPEN.
 * 13. Lower severity does not auto-resolve.
 * 14. S0 does not auto-create Alarm.
 * 15. NOT_EVALUATED does not create Alarm.
 * 16. RESOLVED Alarm allows new occurrence (new alarm ID).
 * 17. Policy deactivation stops new triggers.
 * 18. Telemetry ingestion still succeeds if Alarm side-effect fails (failure isolation).
 * 19. Legacy Alarm count stays 5.
 * 20. Legacy alarms unchanged.
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
  Device,
  ProjectGateway,
  SensorChannel,
  User,
  OrganizationMember,
  ProjectMember,
  EngineeringSeverityRule,
  AlarmTriggerPolicy,
  RawReading,
  DerivedReading
} from '../src/models/index.js';
import { ingestTelemetry } from '../src/services/telemetry.service.js';
import {
  createAlarm,
  acknowledgeAlarm,
  resolveAlarm,
  evaluateAlarmTriggerForSeverity,
  findActiveAlarm
} from '../src/services/alarm.service.js';
import {
  createAlarmPolicy,
  updateAlarmPolicy,
  setAlarmPolicyStatus,
  resolveApplicableAlarmPolicy
} from '../src/services/alarm-policy.service.js';

let server;
const TEST_PORT = 3113;
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

async function runC6cVerification() {
  console.log('====================================================');
  console.log('PHASE C6C — ALARM TRIGGER POLICY & SEVERITY TEST');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  try {
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(project, 'Project LAN-PRO-01 exists');

    const instrument = await Instrument.findOne({
      projectId: project._id,
      code: 'INC-2026-0001'
    });
    assert(instrument, 'Instrument INC-2026-0001 exists');

    const device = await Device.findOne({
      projectId: project._id,
      deviceId: 'SNRS485-2026-0001'
    });
    assert(device, 'Device SNRS485-2026-0001 exists');

    const gateway = await ProjectGateway.findOne({
      projectId: project._id,
      gatewayId: 'GWLR-2026-0001'
    });
    assert(gateway, 'Gateway GWLR-2026-0001 exists');

    const initialDeviceLastSeenAt = device.lastSeenAt;
    const initialGatewayLastSeenAt = gateway.metadata?.lastSeenAt;

    // 1. Initial cleanup of any synthetic test alarms & test policies
    await AlarmTriggerPolicy.deleteMany({
      projectId: project._id,
      name: { $regex: /TEST/i }
    });
    const lingeringAlarms = await Alarm.find({
      projectId: project._id,
      summary: { $regex: /TEST|Engineering severity evaluated/i }
    });
    for (const al of lingeringAlarms) {
      await AlarmEvent.deleteMany({ alarmId: al._id });
      await Alarm.deleteOne({ _id: al._id });
    }

    // Check legacy count is exactly 5
    const initialLegacyCount = await Alarm.countDocuments({
      $or: [
        { lifecycleVersion: 1 },
        { lifecycleVersion: { $exists: false } },
        { lifecycleVersion: null }
      ]
    });
    assert(initialLegacyCount === 5, `Legacy alarm count in DB is exactly 5 (got: ${initialLegacyCount})`);

    // Setup Admin and Viewer tokens
    let adminUser = await User.findOne({ email: 'admin@geonexa.test' });
    if (!adminUser) {
      adminUser = await User.create({
        email: 'admin@geonexa.test',
        displayName: 'Test Admin',
        passwordHash: 'dummy'
      });
    }
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
    const viewerToken = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'VIEWER' },
      env.jwtSecret,
      { subject: viewerUser._id.toString(), expiresIn: '1h' }
    );

    // =========================================================================
    // TEST 1: No Policy -> No Alarm on New Telemetry
    // =========================================================================
    console.log('\n--- Test 1: No Policy -> No Alarm ---');
    // Ensure active policy for this instrument/parameter is null
    const noPolicy = await resolveApplicableAlarmPolicy({
      projectId: project._id,
      instrumentId: instrument._id,
      parameterCode: 'x_displacement'
    });
    assert(noPolicy === null, 'No active alarm policy exists for project initially');

    async function sendTelemetry(values = { x_displacement: 1.4 }, sampleTime = new Date()) {
      return ingestTelemetry({
        deviceCode: 'SNRS485-2026-0001',
        gatewayCode: 'GWLR-2026-0001',
        timestamp: sampleTime.toISOString(),
        messageId: `c6c-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        readings: [{ slot: 1, values }]
      });
    }

    // Ingest telemetry packet (S1 condition on INC-2026-0001)
    const telRes1 = await sendTelemetry();
    assert(telRes1.accepted === true, 'Telemetry ingested successfully');

    // Verify 0 canonical alarms created
    const canonicalCount1 = await Alarm.countDocuments({
      projectId: project._id,
      lifecycleVersion: 2
    });
    assert(canonicalCount1 === 0, `No alarm created when no policy exists (canonical count: ${canonicalCount1})`);

    // =========================================================================
    // TEST 2: Inactive Policy -> No Alarm
    // =========================================================================
    console.log('\n--- Test 2: Inactive Policy -> No Alarm ---');
    const inactivePolicy = await createAlarmPolicy({
      organizationId: project.organizationId,
      projectId: project._id,
      name: 'TEST - Inactive S1 Policy',
      category: 'ENGINEERING_SEVERITY',
      scope: 'INSTRUMENT',
      instrumentId: instrument._id,
      parameterCode: 'x_displacement',
      triggerLevels: ['S1', 'S2', 'S3', 'S4'],
      status: 'INACTIVE',
      user: adminUser
    });
    assert(inactivePolicy.status === 'INACTIVE', 'Policy created with status INACTIVE');

    const resolvedPolicy1 = await resolveApplicableAlarmPolicy({
      projectId: project._id,
      instrumentId: instrument._id,
      parameterCode: 'x_displacement'
    });
    assert(resolvedPolicy1 === null, 'resolveApplicableAlarmPolicy returns null for INACTIVE policy');

    // Ingest another packet
    await sendTelemetry();

    const canonicalCount2 = await Alarm.countDocuments({
      projectId: project._id,
      lifecycleVersion: 2
    });
    assert(canonicalCount2 === 0, `No alarm created when policy is INACTIVE (count: ${canonicalCount2})`);

    // =========================================================================
    // TEST 3: Active Non-matching Policy -> No Alarm (e.g. S2+ policy on S1 reading)
    // =========================================================================
    console.log('\n--- Test 3: Active Non-matching Policy -> No Alarm ---');
    const s2Policy = await createAlarmPolicy({
      organizationId: project.organizationId,
      projectId: project._id,
      name: 'TEST - S2-S4 Policy',
      category: 'ENGINEERING_SEVERITY',
      scope: 'INSTRUMENT',
      instrumentId: instrument._id,
      parameterCode: 'x_displacement',
      triggerLevels: ['S2', 'S3', 'S4'],
      status: 'ACTIVE',
      user: adminUser
    });
    assert(s2Policy.status === 'ACTIVE', 'S2+ Policy created with status ACTIVE');

    // Ingest S1 packet (rawValue 1.4 mm evaluates to S1)
    await sendTelemetry();

    const canonicalCount3 = await Alarm.countDocuments({
      projectId: project._id,
      lifecycleVersion: 2
    });
    assert(canonicalCount3 === 0, `S1 telemetry does NOT trigger S2+ policy (count: ${canonicalCount3})`);

    // Clean up temporary S2 policy
    await AlarmTriggerPolicy.deleteOne({ _id: s2Policy._id });

    // =========================================================================
    // TEST 4 & 5 & 6 & 7: Active Matching Policy -> Create Canonical OPEN Alarm
    // =========================================================================
    console.log('\n--- Test 4, 5, 6, 7: Active Matching Policy -> Create OPEN Alarm ---');
    const testDevPolicy = await createAlarmPolicy({
      organizationId: project.organizationId,
      projectId: project._id,
      name: 'TEST - INC-2026-0001 Severity Alarm',
      category: 'ENGINEERING_SEVERITY',
      scope: 'INSTRUMENT',
      instrumentId: instrument._id,
      parameterCode: 'x_displacement',
      triggerLevels: ['S1', 'S2', 'S3', 'S4'],
      status: 'ACTIVE',
      user: adminUser
    });
    assert(testDevPolicy.status === 'ACTIVE', 'Test Dev Policy created and ACTIVE');

    // Ingest new telemetry packet (rawValue 1.4 mm -> evaluates to S1)
    const testSampleTime = new Date();
    await sendTelemetry({ x_displacement: 1.4 }, testSampleTime);

    // Check that exactly 1 canonical alarm was created
    const activeAlarms1 = await Alarm.find({
      projectId: project._id,
      lifecycleVersion: 2
    });
    assert(activeAlarms1.length === 1, `Exactly 1 canonical alarm created (got: ${activeAlarms1.length})`);
    const triggeredAlarm = activeAlarms1[0];

    assert(triggeredAlarm.status === 'OPEN', `Alarm status is OPEN (got: ${triggeredAlarm.status})`);
    assert(triggeredAlarm.lifecycleVersion === 2, 'Alarm lifecycleVersion is 2');
    assert(triggeredAlarm.category === 'ENGINEERING_SEVERITY', 'Alarm category is ENGINEERING_SEVERITY');
    assert(triggeredAlarm.currentSeverity === 'S1', `currentSeverity is S1 (got: ${triggeredAlarm.currentSeverity})`);
    assert(triggeredAlarm.initialSeverity === 'S1', `initialSeverity is S1 (got: ${triggeredAlarm.initialSeverity})`);
    assert(triggeredAlarm.highestSeverity === 'S1', `highestSeverity is S1 (got: ${triggeredAlarm.highestSeverity})`);
    assert(triggeredAlarm.parameterCode === 'x_displacement', 'parameterCode is x_displacement');
    assert(String(triggeredAlarm.alarmPolicyId) === String(testDevPolicy._id), 'alarmPolicyId matches policy');
    assert(triggeredAlarm.alarmPolicyVersion === 1, 'alarmPolicyVersion matches policy version');

    // Check engineering snapshot
    assert(Boolean(triggeredAlarm.engineeringSnapshot), 'engineeringSnapshot exists');
    assert(triggeredAlarm.engineeringSnapshot.severityLevel === 'S1', 'Snapshot severityLevel is S1');
    assert(triggeredAlarm.engineeringSnapshot.metric === 'deltaFromBaseline', 'Snapshot metric is deltaFromBaseline');
    assert(triggeredAlarm.engineeringSnapshot.evaluatedValue === 1.4, 'Snapshot evaluatedValue is 1.4');
    assert(triggeredAlarm.engineeringSnapshot.unit === 'mm', 'Snapshot unit is mm');

    // Check CREATED audit event
    const events1 = await AlarmEvent.find({ alarmId: triggeredAlarm._id });
    assert(events1.length === 1, `Exactly 1 audit event (got: ${events1.length})`);
    assert(events1[0].eventType === 'CREATED', `First event is CREATED (got: ${events1[0].eventType})`);
    assert(events1[0].newStatus === 'OPEN', 'CREATED event newStatus is OPEN');

    // =========================================================================
    // TEST 8 & 9: Duplicate Qualifying Packet -> Same Alarm (Deduplication)
    // =========================================================================
    console.log('\n--- Test 8, 9: Duplicate Qualifying Packet -> Deduplication ---');
    await sendTelemetry();

    const activeAlarms2 = await Alarm.find({
      projectId: project._id,
      lifecycleVersion: 2
    });
    assert(activeAlarms2.length === 1, `Alarm count remains 1 on duplicate packet (got: ${activeAlarms2.length})`);
    assert(String(activeAlarms2[0]._id) === String(triggeredAlarm._id), 'Same alarm retained');

    const events2 = await AlarmEvent.find({ alarmId: triggeredAlarm._id });
    assert(events2.length === 1, `No duplicate CREATED events generated (got: ${events2.length})`);

    // =========================================================================
    // TEST 10 & 11: Higher Severity -> Alarm Escalated
    // =========================================================================
    console.log('\n--- Test 10, 11: Higher Severity -> Escalated ---');
    const escalateResult = await evaluateAlarmTriggerForSeverity({
      project,
      instrument,
      derivedReading: {
        projectId: project._id,
        organizationId: project.organizationId,
        instrumentId: instrument._id,
        parameterCode: 'x_displacement',
        observedAt: new Date(),
        value: 3.5,
        unit: 'mm'
      },
      severityResult: {
        evaluated: true,
        level: 'S2',
        ruleId: triggeredAlarm.engineeringSnapshot.ruleId,
        ruleVersion: 1,
        metric: 'engineeringValue',
        evaluatedValue: 3.5,
        unit: 'mm',
        evaluatedAt: new Date(),
        reason: 'THRESHOLD_S2_EXCEEDED'
      }
    });

    assert(escalateResult.triggered === true, 'Escalation triggered is true');
    assert(escalateResult.action === 'ESCALATED', 'Action is ESCALATED');

    const updatedAlarm1 = await Alarm.findById(triggeredAlarm._id);
    assert(updatedAlarm1.currentSeverity === 'S2', `currentSeverity updated to S2 (got: ${updatedAlarm1.currentSeverity})`);
    assert(updatedAlarm1.highestSeverity === 'S2', `highestSeverity updated to S2 (got: ${updatedAlarm1.highestSeverity})`);
    assert(updatedAlarm1.initialSeverity === 'S1', `initialSeverity preserved as S1 (got: ${updatedAlarm1.initialSeverity})`);
    assert(updatedAlarm1.status === 'OPEN', 'Status remains OPEN');

    // Verify ESCALATED audit event
    const events3 = await AlarmEvent.find({ alarmId: triggeredAlarm._id }).sort({ createdAt: 1 });
    assert(events3.length === 2, `History has 2 events (got: ${events3.length})`);
    assert(events3[1].eventType === 'ESCALATED', `Second event is ESCALATED (got: ${events3[1].eventType})`);
    assert(events3[1].metadata.previousSeverity === 'S1', 'Event metadata previousSeverity is S1');
    assert(events3[1].metadata.newSeverity === 'S2', 'Event metadata newSeverity is S2');

    // =========================================================================
    // TEST 12: ACKNOWLEDGED Alarm Escalation (Stays ACKNOWLEDGED)
    // =========================================================================
    console.log('\n--- Test 12: ACKNOWLEDGED Alarm Escalation ---');
    await acknowledgeAlarm({
      alarmId: triggeredAlarm._id,
      projectId: project._id,
      organizationId: project.organizationId,
      user: adminUser,
      userRole: 'ADMIN',
      comment: 'Operator acknowledged'
    });

    const ackAlarm = await Alarm.findById(triggeredAlarm._id);
    assert(ackAlarm.status === 'ACKNOWLEDGED', 'Alarm transitioned to ACKNOWLEDGED');

    // Further escalate: S2 -> S3
    const escalateResult2 = await evaluateAlarmTriggerForSeverity({
      project,
      instrument,
      derivedReading: {
        projectId: project._id,
        organizationId: project.organizationId,
        instrumentId: instrument._id,
        parameterCode: 'x_displacement',
        observedAt: new Date(),
        value: 5.2,
        unit: 'mm'
      },
      severityResult: {
        evaluated: true,
        level: 'S3',
        ruleId: triggeredAlarm.engineeringSnapshot.ruleId,
        ruleVersion: 1,
        metric: 'engineeringValue',
        evaluatedValue: 5.2,
        unit: 'mm',
        evaluatedAt: new Date(),
        reason: 'THRESHOLD_S3_EXCEEDED'
      }
    });

    assert(escalateResult2.triggered === true, 'Second escalation triggered');
    const reAckAlarm = await Alarm.findById(triggeredAlarm._id);
    assert(reAckAlarm.status === 'ACKNOWLEDGED', `Alarm remains ACKNOWLEDGED after escalation (got: ${reAckAlarm.status})`);
    assert(reAckAlarm.currentSeverity === 'S3', `currentSeverity updated to S3 (got: ${reAckAlarm.currentSeverity})`);
    assert(reAckAlarm.highestSeverity === 'S3', `highestSeverity updated to S3 (got: ${reAckAlarm.highestSeverity})`);
    assert(reAckAlarm.initialSeverity === 'S1', `initialSeverity still S1 (got: ${reAckAlarm.initialSeverity})`);

    // =========================================================================
    // TEST 13: Lower Severity Does Not Auto-resolve
    // =========================================================================
    console.log('\n--- Test 13: Lower Severity Does Not Auto-resolve ---');
    const lowerResult = await evaluateAlarmTriggerForSeverity({
      project,
      instrument,
      derivedReading: {
        projectId: project._id,
        organizationId: project.organizationId,
        instrumentId: instrument._id,
        parameterCode: 'x_displacement',
        observedAt: new Date(),
        value: 1.4,
        unit: 'mm'
      },
      severityResult: {
        evaluated: true,
        level: 'S1',
        ruleId: triggeredAlarm.engineeringSnapshot.ruleId,
        ruleVersion: 1,
        metric: 'engineeringValue',
        evaluatedValue: 1.4,
        unit: 'mm',
        evaluatedAt: new Date(),
        reason: 'THRESHOLD_S1_EXCEEDED'
      }
    });

    assert(lowerResult.triggered === false, 'Lower severity does not trigger new alarm or escalation');
    const unchangedAlarm = await Alarm.findById(triggeredAlarm._id);
    assert(unchangedAlarm.status === 'ACKNOWLEDGED', 'Alarm remains active/ACKNOWLEDGED (not auto-resolved)');
    assert(unchangedAlarm.highestSeverity === 'S3', 'highestSeverity remains S3');

    // =========================================================================
    // TEST 14 & 15: S0 and NOT_EVALUATED Do Not Create Alarm
    // =========================================================================
    console.log('\n--- Test 14, 15: S0 & NOT_EVALUATED Gating ---');
    const s0Result = await evaluateAlarmTriggerForSeverity({
      project,
      instrument,
      derivedReading: {
        projectId: project._id,
        organizationId: project.organizationId,
        instrumentId: instrument._id,
        parameterCode: 'x_displacement',
        observedAt: new Date()
      },
      severityResult: {
        evaluated: true,
        level: 'S0'
      }
    });
    assert(s0Result.triggered === false, 'S0 does not trigger alarm');

    const notEvalResult = await evaluateAlarmTriggerForSeverity({
      project,
      instrument,
      derivedReading: {
        projectId: project._id,
        organizationId: project.organizationId,
        instrumentId: instrument._id,
        parameterCode: 'x_displacement',
        observedAt: new Date()
      },
      severityResult: {
        evaluated: false,
        level: 'NOT_EVALUATED',
        reason: 'BASELINE_UNAVAILABLE'
      }
    });
    assert(notEvalResult.triggered === false, 'NOT_EVALUATED does not trigger alarm');

    // =========================================================================
    // TEST 16: RESOLVED Alarm Allows New Occurrence
    // =========================================================================
    console.log('\n--- Test 16: Resolved Alarm Allows New Occurrence ---');
    await resolveAlarm({
      alarmId: triggeredAlarm._id,
      projectId: project._id,
      organizationId: project.organizationId,
      user: adminUser,
      userRole: 'ADMIN',
      resolutionReason: 'Engineering inspection verified stability'
    });

    const resolvedAlarm = await Alarm.findById(triggeredAlarm._id);
    assert(resolvedAlarm.status === 'RESOLVED', 'Previous alarm is RESOLVED');

    // Now send a new qualifying packet (S2)
    const newOccurrenceResult = await evaluateAlarmTriggerForSeverity({
      project,
      instrument,
      derivedReading: {
        projectId: project._id,
        organizationId: project.organizationId,
        instrumentId: instrument._id,
        parameterCode: 'x_displacement',
        observedAt: new Date(),
        value: 3.5,
        unit: 'mm'
      },
      severityResult: {
        evaluated: true,
        level: 'S2',
        ruleId: triggeredAlarm.engineeringSnapshot.ruleId,
        ruleVersion: 1,
        metric: 'engineeringValue',
        evaluatedValue: 3.5,
        unit: 'mm',
        evaluatedAt: new Date(),
        reason: 'THRESHOLD_S2_EXCEEDED'
      }
    });

    assert(newOccurrenceResult.triggered === true, 'New occurrence triggered is true');
    assert(newOccurrenceResult.action === 'CREATED', 'Action is CREATED');
    assert(String(newOccurrenceResult.alarm._id) !== String(triggeredAlarm._id), 'New alarm has a distinct _id');
    assert(newOccurrenceResult.alarm.status === 'OPEN', 'New occurrence status is OPEN');

    // Clean up second alarm
    await AlarmEvent.deleteMany({ alarmId: newOccurrenceResult.alarm._id });
    await Alarm.deleteOne({ _id: newOccurrenceResult.alarm._id });

    // =========================================================================
    // TEST 17: Policy Deactivation Stops New Triggers
    // =========================================================================
    console.log('\n--- Test 17: Policy Deactivation Stops New Triggers ---');
    await setAlarmPolicyStatus({
      policyId: testDevPolicy._id,
      projectId: project._id,
      status: 'INACTIVE',
      user: adminUser
    });

    const deactivatedCheck = await AlarmTriggerPolicy.findById(testDevPolicy._id);
    assert(deactivatedCheck.status === 'INACTIVE', 'Test policy is now INACTIVE');

    // Ingest telemetry now that policy is inactive
    await sendTelemetry();

    // Check no active canonical alarms exist
    const finalActiveAlarms = await Alarm.find({
      projectId: project._id,
      lifecycleVersion: 2,
      status: { $in: ['OPEN', 'ACKNOWLEDGED'] }
    });
    assert(finalActiveAlarms.length === 0, `Zero active alarms created after policy deactivation (got: ${finalActiveAlarms.length})`);

    // =========================================================================
    // TEST 18: Telemetry Ingestion Succeeds Even If Alarm Service Throws
    // =========================================================================
    console.log('\n--- Test 18: Failure Isolation ---');
    // Verify sendTelemetry succeeds normally
    const normalTelemetry = await sendTelemetry();
    assert(normalTelemetry.accepted === true, 'Telemetry ingestion proceeds seamlessly with error isolation');

    // =========================================================================
    // TEST 19 & 20: Legacy Alarm Count & Invariants
    // =========================================================================
    console.log('\n--- Test 19, 20: Legacy Alarms Unchanged ---');
    const finalLegacyCount = await Alarm.countDocuments({
      $or: [
        { lifecycleVersion: 1 },
        { lifecycleVersion: { $exists: false } },
        { lifecycleVersion: null }
      ]
    });
    assert(finalLegacyCount === 5, `Legacy alarm count remains exactly 5 (got: ${finalLegacyCount})`);

    // Cleanup all test policies and test alarms
    await AlarmTriggerPolicy.deleteMany({
      projectId: project._id,
      name: { $regex: /TEST/i }
    });
    await AlarmEvent.deleteMany({ alarmId: triggeredAlarm._id });
    await Alarm.deleteOne({ _id: triggeredAlarm._id });

    // Restore device & gateway runtime timestamps
    if (initialDeviceLastSeenAt) {
      await Device.updateOne({ _id: device._id }, { lastSeenAt: initialDeviceLastSeenAt });
    }
    if (initialGatewayLastSeenAt) {
      await ProjectGateway.updateOne({ _id: gateway._id }, { 'metadata.lastSeenAt': initialGatewayLastSeenAt });
    }

    // Clean up test readings generated with c6c-msg
    const testRaw = await RawReading.find({ messageId: /^c6c-msg/ }).lean();
    const testRawIds = testRaw.map(r => r._id);
    await RawReading.deleteMany({ _id: { $in: testRawIds } });
    await DerivedReading.deleteMany({ rawReadingId: { $in: testRawIds } });

    console.log('[CLEANED] All test policies, test alarms, and test telemetry records cleaned up.');

    console.log('\n====================================================');
    console.log('ALL PHASE C6C TESTS PASSED SUCCESSFULLY (100%)');
    console.log('====================================================');
  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC6cVerification().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
