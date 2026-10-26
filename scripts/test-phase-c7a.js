#!/usr/bin/env node

/**
 * PHASE C7A — CANONICAL INVESTIGATION BACKEND FOUNDATION TEST
 *
 * Verifies:
 * 1. Create Investigation from canonical Alarm.
 * 2. Alarm/project linkage correct.
 * 3. Investigation status starts OPEN.
 * 4. CREATED event exists.
 * 5. Duplicate active investigation for same Alarm rejected.
 * 6. Assign project user.
 * 7. ASSIGNED event exists.
 * 8. Start Investigation.
 * 9. OPEN -> IN_PROGRESS.
 * 10. startedAt set.
 * 11. STARTED event exists.
 * 12. Add finding.
 * 13. finding persisted.
 * 14. FINDING_ADDED event exists.
 * 15. Complete Investigation.
 * 16. IN_PROGRESS -> COMPLETED.
 * 17. completedAt/completedBy set.
 * 18. conclusion persisted.
 * 19. COMPLETED event exists.
 * 20. Invalid lifecycle transition rejected.
 * 21. Cross-project access rejected.
 * 22. Viewer mutation rejected.
 * 23. Linked Alarm remains unchanged by Investigation lifecycle.
 * 24. Legacy Alarm count remains unchanged.
 * 25. Canonical Alarm audit remains unchanged.
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
  Investigation,
  InvestigationEvent,
  InvestigationNote
} from '../src/models/index.js';
import { getAlarm } from '../src/services/alarm.service.js';

let server;
const TEST_PORT = 3114;
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

async function runC7aVerification() {
  console.log('====================================================');
  console.log('PHASE C7A — CANONICAL INVESTIGATION BACKEND TEST');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  try {
    // 1. Resolve Project LAN-PRO-01
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(project, 'Project LAN-PRO-01 exists');

    // 2. Resolve Canonical Test Alarm (INC-2026-0001, resolved, S4)
    let canonicalAlarm = await Alarm.findOne({
      projectId: project._id,
      lifecycleVersion: 2,
      status: 'RESOLVED'
    });

    if (!canonicalAlarm) {
      console.log('[SETUP] Restoring canonical resolved test alarm INC-2026-0001 (S1 -> S4 resolved)...');
      const inst = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' });
      const alarmDoc = {
        _id: new mongoose.Types.ObjectId('6ad0d886fca52330dfb4d3f8'),
        organizationId: project.organizationId,
        projectId: project._id,
        instrumentId: inst?._id || new mongoose.Types.ObjectId('6ac736b75fed52ab6c39549c'),
        type: 'ENGINEERING',
        title: 'INC-2026-0001 · X displacement',
        severity: 'S4',
        healthGrade: 'H0',
        state: 'CLOSED',
        openedAt: new Date('2026-10-15T13:43:34.588Z'),
        reasonCodes: ['THRESHOLD_S1_EXCEEDED'],
        lifecycleVersion: 2,
        category: 'ENGINEERING_SEVERITY',
        source: 'ENGINEERING_SEVERITY',
        status: 'RESOLVED',
        summary: 'Engineering severity evaluated to S1 for x_displacement (1.266 mm)',
        reason: 'THRESHOLD_S1_EXCEEDED',
        parameterCode: 'x_displacement',
        triggeredAt: new Date('2026-10-15T13:43:34.588Z'),
        engineeringSnapshot: {
          severityLevel: 'S1',
          ruleId: new mongoose.Types.ObjectId('6acde1b7c5e11c7ce04c2978'),
          ruleVersion: 1,
          metric: 'deltaFromBaseline',
          evaluatedValue: 1.266,
          unit: 'mm',
          observedAt: new Date('2026-10-15T13:43:34.588Z'),
          severityEvaluatedAt: new Date('2026-10-15T13:43:34.588Z'),
          reason: 'THRESHOLD_S1_EXCEEDED',
          alarmPolicyId: new mongoose.Types.ObjectId('6ad0ce62fca52330dfb4d068'),
          alarmPolicyVersion: 1
        },
        currentEngineeringSnapshot: {
          severityLevel: 'S4',
          ruleId: new mongoose.Types.ObjectId('6acde1b7c5e11c7ce04c2978'),
          ruleVersion: 1,
          metric: 'deltaFromBaseline',
          evaluatedValue: 4.2,
          unit: 'mm',
          observedAt: new Date('2026-10-15T14:01:28.518Z'),
          severityEvaluatedAt: new Date('2026-10-15T14:01:28.695Z'),
          reason: null,
          alarmPolicyId: new mongoose.Types.ObjectId('6ad0ce62fca52330dfb4d068'),
          alarmPolicyVersion: 1
        },
        initialSeverity: 'S1',
        currentSeverity: 'S4',
        highestSeverity: 'S4',
        alarmPolicyId: new mongoose.Types.ObjectId('6ad0ce62fca52330dfb4d068'),
        alarmPolicyVersion: 1,
        acknowledgedAt: new Date('2026-10-16T07:54:59.883Z'),
        acknowledgedBy: new mongoose.Types.ObjectId('6ac4cce70f25c8b970d45598'),
        lastComment: 'Alarm resolved',
        resolutionCode: 'Development alarm lifecycle test completed',
        resolutionReason: 'Development alarm lifecycle test completed',
        resolvedAt: new Date('2026-10-26T09:35:28.290Z'),
        resolvedBy: new mongoose.Types.ObjectId('6ac4cce70f25c8b970d45598'),
        createdAt: new Date('2026-10-16T05:22:57.539Z'),
        updatedAt: new Date('2026-10-26T09:35:28.293Z')
      };

      const events = [
        {
          _id: new mongoose.Types.ObjectId('6ad1d4dcee08e538b91e02a0'),
          alarmId: alarmDoc._id,
          projectId: alarmDoc.projectId,
          actorType: 'SYSTEM',
          actorDisplayName: 'Engineering Severity Engine',
          eventType: 'CREATED',
          previousStatus: null,
          newStatus: 'OPEN',
          fromState: null,
          toState: 'TRIGGERED',
          comment: "Canonical alarm triggered by policy 'Policy 1' (v1) on S1",
          metadata: {
            category: 'ENGINEERING_SEVERITY',
            severity: 'S1',
            initialSeverity: 'S1',
            policyName: 'Policy 1',
            alarmPolicyId: '6ad0ce62fca52330dfb4d068',
            alarmPolicyVersion: 1,
            ruleId: '6acde1b7c5e11c7ce04c2978',
            ruleVersion: 1,
            evaluatedValue: 1.266,
            unit: 'mm',
            observedAt: '2026-10-15T13:43:34.588Z'
          },
          createdAt: new Date('2026-10-15T13:43:34.588Z'),
          updatedAt: new Date('2026-10-15T13:43:34.588Z')
        },
        {
          _id: new mongoose.Types.ObjectId('6ad1d4dcee08e538b91e02a1'),
          alarmId: alarmDoc._id,
          projectId: alarmDoc.projectId,
          actorType: 'SYSTEM',
          actorDisplayName: 'Engineering Severity Engine',
          eventType: 'ESCALATED',
          previousStatus: 'OPEN',
          newStatus: 'OPEN',
          comment: 'Severity escalated from S1 to S2',
          metadata: {
            previousSeverity: 'S1',
            newSeverity: 'S2',
            highestSeverity: 'S2',
            evaluatedValue: 2.2,
            unit: 'mm',
            policyName: 'Policy 1',
            alarmPolicyId: '6ad0ce62fca52330dfb4d068',
            alarmPolicyVersion: 1,
            ruleId: '6acde1b7c5e11c7ce04c2978',
            ruleVersion: 1,
            observedAt: '2026-10-15T14:00:58.039Z'
          },
          createdAt: new Date('2026-10-15T14:00:58.050Z'),
          updatedAt: new Date('2026-10-15T14:00:58.050Z')
        },
        {
          _id: new mongoose.Types.ObjectId('6ad1d4dcee08e538b91e02a2'),
          alarmId: alarmDoc._id,
          projectId: alarmDoc.projectId,
          actorType: 'SYSTEM',
          actorDisplayName: 'Engineering Severity Engine',
          eventType: 'ESCALATED',
          previousStatus: 'OPEN',
          newStatus: 'OPEN',
          comment: 'Severity escalated from S2 to S3',
          metadata: {
            previousSeverity: 'S2',
            newSeverity: 'S3',
            highestSeverity: 'S3',
            evaluatedValue: 3.2,
            unit: 'mm',
            policyName: 'Policy 1',
            alarmPolicyId: '6ad0ce62fca52330dfb4d068',
            alarmPolicyVersion: 1,
            ruleId: '6acde1b7c5e11c7ce04c2978',
            ruleVersion: 1,
            observedAt: '2026-10-15T14:01:09.534Z'
          },
          createdAt: new Date('2026-10-15T14:01:09.548Z'),
          updatedAt: new Date('2026-10-15T14:01:09.548Z')
        },
        {
          _id: new mongoose.Types.ObjectId('6ad1d4dcee08e538b91e02a3'),
          alarmId: alarmDoc._id,
          projectId: alarmDoc.projectId,
          actorType: 'SYSTEM',
          actorDisplayName: 'Engineering Severity Engine',
          eventType: 'ESCALATED',
          previousStatus: 'OPEN',
          newStatus: 'OPEN',
          comment: 'Severity escalated from S3 to S4',
          metadata: {
            previousSeverity: 'S3',
            newSeverity: 'S4',
            highestSeverity: 'S4',
            evaluatedValue: 4.2,
            unit: 'mm',
            policyName: 'Policy 1',
            alarmPolicyId: '6ad0ce62fca52330dfb4d068',
            alarmPolicyVersion: 1,
            ruleId: '6acde1b7c5e11c7ce04c2978',
            ruleVersion: 1,
            observedAt: '2026-10-15T14:01:28.518Z'
          },
          createdAt: new Date('2026-10-15T14:01:28.653Z'),
          updatedAt: new Date('2026-10-15T14:01:28.653Z')
        },
        {
          _id: new mongoose.Types.ObjectId('6ad1d853d7093da61dfe6b0a'),
          alarmId: alarmDoc._id,
          projectId: alarmDoc.projectId,
          actorType: 'USER',
          actorId: new mongoose.Types.ObjectId('6ac4cce70f25c8b970d45598'),
          actorEmail: 'org1@yopmail.com',
          actorDisplayName: 'Person-1',
          eventType: 'ACKNOWLEDGED',
          previousStatus: 'OPEN',
          newStatus: 'ACKNOWLEDGED',
          fromState: 'TRIGGERED',
          toState: 'ACKNOWLEDGED',
          comment: 'Alarm acknowledged',
          createdAt: new Date('2026-10-16T07:54:59.920Z'),
          updatedAt: new Date('2026-10-16T07:54:59.920Z')
        },
        {
          _id: new mongoose.Types.ObjectId('6adf1ee0f23db0d0baa58897'),
          alarmId: alarmDoc._id,
          projectId: alarmDoc.projectId,
          actorType: 'USER',
          actorId: new mongoose.Types.ObjectId('6ac4cce70f25c8b970d45598'),
          actorEmail: 'org1@yopmail.com',
          actorDisplayName: 'Person-1',
          eventType: 'RESOLVED',
          previousStatus: 'ACKNOWLEDGED',
          newStatus: 'RESOLVED',
          fromState: 'ACKNOWLEDGED',
          toState: 'CLOSED',
          comment: 'Alarm resolved',
          metadata: {
            resolutionReason: 'Development alarm lifecycle test completed'
          },
          createdAt: new Date('2026-10-26T09:35:28.331Z'),
          updatedAt: new Date('2026-10-26T09:35:28.331Z')
        }
      ];

      await mongoose.connection.db.collection('alarms').deleteOne({ _id: alarmDoc._id });
      await mongoose.connection.db.collection('alarms').insertOne(alarmDoc);
      await mongoose.connection.db.collection('alarmevents').deleteMany({ alarmId: alarmDoc._id });
      await mongoose.connection.db.collection('alarmevents').insertMany(events);

      canonicalAlarm = await Alarm.findById(alarmDoc._id);
    }

    assert(canonicalAlarm, 'Canonical resolved test alarm exists in project');
    console.log(`[INFO] Found canonical Alarm: ${canonicalAlarm._id} (${canonicalAlarm.title}, status: ${canonicalAlarm.status}, currentSev: ${canonicalAlarm.currentSeverity})`);

    // Baseline snapshot of canonical alarm & events
    const initialAlarmSnapshot = JSON.stringify(canonicalAlarm.toObject());
    const initialAlarmEventsCount = await AlarmEvent.countDocuments({ alarmId: canonicalAlarm._id });
    console.log(`[INFO] Initial canonical AlarmEvent count: ${initialAlarmEventsCount}`);

    // Count legacy alarms in DB
    const legacyAlarms = await Alarm.find({
      $or: [
        { lifecycleVersion: 1 },
        { lifecycleVersion: { $exists: false } },
        { lifecycleVersion: null }
      ]
    });
    console.log(`[INFO] Initial legacy alarm count in DB: ${legacyAlarms.length}`);
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
      { organizationRole: 'ADMINISTRATOR', status: 'ACTIVE' },
      { upsert: true }
    );
    await ProjectMember.findOneAndUpdate(
      { projectId: project._id, userId: adminUser._id },
      { role: 'ADMINISTRATOR', status: 'ACTIVE' },
      { upsert: true }
    );

    const adminToken = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: adminUser._id.toString(), expiresIn: '1h' }
    );

    let engineerUser = await User.findOne({ email: 'engineer@geonexa.test' });
    if (!engineerUser) {
      engineerUser = await User.create({
        email: 'engineer@geonexa.test',
        displayName: 'Test Engineer',
        passwordHash: 'dummy'
      });
    }
    await OrganizationMember.findOneAndUpdate(
      { organizationId: project.organizationId, userId: engineerUser._id },
      { organizationRole: 'ENGINEER', status: 'ACTIVE' },
      { upsert: true }
    );
    await ProjectMember.findOneAndUpdate(
      { projectId: project._id, userId: engineerUser._id },
      { role: 'ENGINEER', status: 'ACTIVE' },
      { upsert: true }
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

    let externalUser = await User.findOne({ email: 'external@geonexa.test' });
    if (!externalUser) {
      externalUser = await User.create({
        email: 'external@geonexa.test',
        displayName: 'External User',
        passwordHash: 'dummy'
      });
    }

    // Secondary project for cross-project isolation tests
    let secondaryProject = await Project.findOne({ code: 'LAN-SEC-TEST' });
    if (!secondaryProject) {
      secondaryProject = await Project.create({
        name: 'Secondary Test Project',
        code: 'LAN-SEC-TEST',
        organizationId: project.organizationId,
        status: 'ACTIVE'
      });
    }

    // Clean up any existing test investigations for this alarm to ensure clean test run
    const existingTestInvs = await Investigation.find({
      projectId: project._id,
      alarmId: canonicalAlarm._id
    });
    for (const inv of existingTestInvs) {
      await InvestigationEvent.deleteMany({ investigationId: inv._id });
      await InvestigationNote.deleteMany({ investigationId: inv._id });
      await Investigation.deleteOne({ _id: inv._id });
    }

    // =========================================================================
    // TEST 1, 2, 3, 4: Create Investigation from Canonical Alarm
    // =========================================================================
    console.log('\n--- Test 1, 2, 3, 4: Create Investigation from Canonical Alarm ---');
    const createRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        title: 'TEST - INC-2026-0001 Alarm Investigation',
        description: 'Development test investigation linked to resolved alarm INC-2026-0001',
        alarmId: canonicalAlarm._id.toString(),
        priority: 'HIGH'
      })
    });

    assert(createRes.status === 201, `Create endpoint returned HTTP 201 (got: ${createRes.status})`);
    const createdInv = await createRes.json();
    assert(createdInv._id, 'Investigation document created with valid _id');
    assert(createdInv.status === 'OPEN', `Investigation status starts OPEN (got: ${createdInv.status})`);
    assert(createdInv.investigationCode?.startsWith('INV-'), `Investigation code generated (got: ${createdInv.investigationCode})`);
    assert(createdInv.alarmId === canonicalAlarm._id.toString(), 'Linked alarmId matches canonical Alarm');
    assert(createdInv.instrumentId === canonicalAlarm.instrumentId?.toString(), 'Linked instrumentId matches Alarm instrument');
    assert(createdInv.parameterCode === 'x_displacement', 'parameterCode copied from Alarm');
    assert(createdInv.alarmSnapshot, 'alarmSnapshot exists');
    assert(createdInv.alarmSnapshot.title === canonicalAlarm.title, 'Snapshot alarm title captured');
    assert(createdInv.alarmSnapshot.initialSeverity === 'S1', 'Snapshot initialSeverity captured S1');
    assert(createdInv.alarmSnapshot.highestSeverity === 'S4', 'Snapshot highestSeverity captured S4');
    assert(createdInv.alarmSnapshot.currentSeverity === 'S4', 'Snapshot currentSeverity captured S4');
    assert(createdInv.alarmSnapshot.status === 'RESOLVED', 'Snapshot captured resolved status');

    // Audit event check: CREATED
    const createdEvents = await InvestigationEvent.find({ investigationId: createdInv._id });
    assert(createdEvents.length === 1, `Exactly 1 audit event exists after creation (got: ${createdEvents.length})`);
    assert(createdEvents[0].eventType === 'CREATED', `Event type is CREATED (got: ${createdEvents[0].eventType})`);
    assert(createdEvents[0].newStatus === 'OPEN', `Event newStatus is OPEN (got: ${createdEvents[0].newStatus})`);

    // =========================================================================
    // TEST 5: Duplicate Active Investigation Rejected
    // =========================================================================
    console.log('\n--- Test 5: Duplicate Active Investigation Rejected ---');
    const duplicateRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        title: 'TEST - Duplicate Investigation',
        alarmId: canonicalAlarm._id.toString()
      })
    });
    assert(duplicateRes.status === 409, `Duplicate active investigation rejected with HTTP 409 (got: ${duplicateRes.status})`);

    // =========================================================================
    // TEST 6, 7: Assign Project User
    // =========================================================================
    console.log('\n--- Test 6, 7: Assign Project User ---');
    // First, verify external user assignment is rejected
    const invalidAssignRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ assignedTo: externalUser._id.toString() })
    });
    assert(invalidAssignRes.status === 400, `Assigning non-project user rejected with HTTP 400 (got: ${invalidAssignRes.status})`);

    // Valid assignment to project Engineer
    const assignRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        assignedTo: engineerUser._id.toString(),
        comment: 'Assigned to geotechnical engineer for review'
      })
    });
    assert(assignRes.status === 200, `Assign endpoint returned HTTP 200 (got: ${assignRes.status})`);
    const assignedInv = await assignRes.json();
    assert(assignedInv.assignedTo === engineerUser._id.toString(), 'assignedTo populated with Engineer ID');
    assert(Boolean(assignedInv.assignedAt), 'assignedAt timestamp populated');

    // Check ASSIGNED audit event
    const assignEvents = await InvestigationEvent.find({ investigationId: createdInv._id, eventType: 'ASSIGNED' });
    assert(assignEvents.length === 1, `ASSIGNED event exists (got: ${assignEvents.length})`);
    assert(assignEvents[0].eventType === 'ASSIGNED', 'Event type is ASSIGNED');

    // =========================================================================
    // TEST 8, 9, 10, 11: Start Investigation (OPEN -> IN_PROGRESS)
    // =========================================================================
    console.log('\n--- Test 8, 9, 10, 11: Start Investigation ---');
    const startRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ comment: 'Operator commenced active investigation' })
    });
    assert(startRes.status === 200, `Start endpoint returned HTTP 200 (got: ${startRes.status})`);
    const startedInv = await startRes.json();
    assert(startedInv.status === 'IN_PROGRESS', `Status transitioned to IN_PROGRESS (got: ${startedInv.status})`);
    assert(Boolean(startedInv.startedAt), 'startedAt timestamp is set');

    // Check STARTED audit event
    const startEvents = await InvestigationEvent.find({ investigationId: createdInv._id, eventType: 'STARTED' });
    assert(startEvents.length === 1, `STARTED event exists (got: ${startEvents.length})`);
    assert(startEvents[0].previousStatus === 'OPEN', `STARTED event previousStatus is OPEN (got: ${startEvents[0].previousStatus})`);
    assert(startEvents[0].newStatus === 'IN_PROGRESS', `STARTED event newStatus is IN_PROGRESS (got: ${startEvents[0].newStatus})`);

    // =========================================================================
    // TEST 12, 13, 14: Add Finding
    // =========================================================================
    console.log('\n--- Test 12, 13, 14: Add Finding ---');
    // Verify empty finding is rejected
    const emptyFindingRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/findings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ text: '   ' })
    });
    assert(emptyFindingRes.status === 400, `Empty finding rejected with HTTP 400 (got: ${emptyFindingRes.status})`);

    // Valid finding
    const findingRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/findings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        text: 'Development verification of alarm escalation workflow.',
        type: 'FINDING'
      })
    });
    assert(findingRes.status === 201, `Add finding endpoint returned HTTP 201 (got: ${findingRes.status})`);
    const findingData = await findingRes.json();
    assert(findingData.finding?._id, 'Finding note created and persisted');
    assert(findingData.finding.text === 'Development verification of alarm escalation workflow.', 'Finding text correctly saved');

    // Verify FINDING_ADDED audit event
    const findingEvents = await InvestigationEvent.find({ investigationId: createdInv._id, eventType: 'FINDING_ADDED' });
    assert(findingEvents.length === 1, `FINDING_ADDED event exists (got: ${findingEvents.length})`);
    assert(findingEvents[0].eventType === 'FINDING_ADDED', 'Event type is FINDING_ADDED');

    // =========================================================================
    // TEST 15, 16, 17, 18, 19: Complete Investigation (IN_PROGRESS -> COMPLETED)
    // =========================================================================
    console.log('\n--- Test 15, 16, 17, 18, 19: Complete Investigation ---');
    // Empty conclusion rejected
    const emptyConclusionRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ conclusion: '' })
    });
    assert(emptyConclusionRes.status === 400, `Empty conclusion rejected with HTTP 400 (got: ${emptyConclusionRes.status})`);

    // Valid completion
    const completeRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        conclusion: 'Canonical alarm lifecycle and escalation verified during development test.',
        rootCause: 'Synthetic multi-step sensor escalation simulation',
        recommendedAction: 'Proceed to Phase C7B Investigation UI',
        comment: 'Investigation successfully completed'
      })
    });
    assert(completeRes.status === 200, `Complete endpoint returned HTTP 200 (got: ${completeRes.status})`);
    const completedInv = await completeRes.json();
    assert(completedInv.status === 'COMPLETED', `Investigation status is COMPLETED (got: ${completedInv.status})`);
    assert(Boolean(completedInv.completedAt), 'completedAt timestamp is set');
    assert(Boolean(completedInv.completedBy), 'completedBy user is set');
    assert(completedInv.conclusion === 'Canonical alarm lifecycle and escalation verified during development test.', 'Conclusion properly saved');
    assert(completedInv.rootCause === 'Synthetic multi-step sensor escalation simulation', 'rootCause properly saved');

    // Verify COMPLETED event exists
    const completeEvents = await InvestigationEvent.find({ investigationId: createdInv._id, eventType: 'COMPLETED' });
    assert(completeEvents.length === 1, `COMPLETED audit event exists (got: ${completeEvents.length})`);
    assert(completeEvents[0].previousStatus === 'IN_PROGRESS', `COMPLETED event previousStatus is IN_PROGRESS (got: ${completeEvents[0].previousStatus})`);
    assert(completeEvents[0].newStatus === 'COMPLETED', `COMPLETED event newStatus is COMPLETED (got: ${completeEvents[0].newStatus})`);

    // =========================================================================
    // TEST 20: Invalid Lifecycle Transitions Rejected
    // =========================================================================
    console.log('\n--- Test 20: Invalid Lifecycle Transitions Rejected ---');
    // Cannot start a completed investigation
    const restartRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ comment: 'Attempting invalid restart' })
    });
    assert(restartRes.status === 409, `Restarting completed investigation rejected with HTTP 409 (got: ${restartRes.status})`);

    // Cannot re-complete an already completed investigation
    const reCompleteRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ conclusion: 'Attempt re-complete' })
    });
    assert(reCompleteRes.status === 409, `Re-completing completed investigation rejected with HTTP 409 (got: ${reCompleteRes.status})`);

    // Cannot add finding to completed investigation
    const postCompleteFindingRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/findings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ text: 'Attempting finding on completed investigation' })
    });
    assert(postCompleteFindingRes.status === 409, `Adding finding to completed investigation rejected with HTTP 409 (got: ${postCompleteFindingRes.status})`);

    // =========================================================================
    // TEST 21: Cross-Project Access Rejected
    // =========================================================================
    console.log('\n--- Test 21: Cross-Project Access Rejected ---');
    const crossProjectGetRes = await fetch(`${BASE_URL}/api/v1/projects/${secondaryProject._id}/investigations/${createdInv._id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(crossProjectGetRes.status === 404 || crossProjectGetRes.status === 403, `Cross-project GET rejected with 404/403 (got: ${crossProjectGetRes.status})`);

    const crossProjectStartRes = await fetch(`${BASE_URL}/api/v1/projects/${secondaryProject._id}/investigations/${createdInv._id}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ comment: 'Cross project start' })
    });
    assert(crossProjectStartRes.status === 404 || crossProjectStartRes.status === 403, `Cross-project mutation rejected with 404/403 (got: ${crossProjectStartRes.status})`);

    // =========================================================================
    // TEST 22: Viewer Role Mutation Rejected (Read-Only)
    // =========================================================================
    console.log('\n--- Test 22: Viewer Role Mutation Rejected ---');
    // Viewer read is allowed
    const viewerGetRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}`, {
      headers: { Authorization: `Bearer ${viewerToken}` }
    });
    assert(viewerGetRes.status === 200, `Viewer can read investigation (HTTP 200)`);
    const viewerDetail = await viewerGetRes.json();
    assert(viewerDetail.investigation?._id, 'Viewer received investigation detail payload');
    assert(Array.isArray(viewerDetail.events), 'Viewer received audit events');
    assert(Array.isArray(viewerDetail.findings), 'Viewer received findings');

    // Viewer create rejected
    const viewerCreateRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`
      },
      body: JSON.stringify({ title: 'Viewer Attempt' })
    });
    assert(viewerCreateRes.status === 403, `Viewer create rejected with HTTP 403 (got: ${viewerCreateRes.status})`);

    // Viewer assign rejected
    const viewerAssignRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`
      },
      body: JSON.stringify({ assignedTo: engineerUser._id.toString() })
    });
    assert(viewerAssignRes.status === 403, `Viewer assign rejected with HTTP 403 (got: ${viewerAssignRes.status})`);

    // Viewer finding rejected
    const viewerFindingRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations/${createdInv._id}/findings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewerToken}`
      },
      body: JSON.stringify({ text: 'Viewer finding' })
    });
    assert(viewerFindingRes.status === 403, `Viewer add finding rejected with HTTP 403 (got: ${viewerFindingRes.status})`);

    // =========================================================================
    // TEST 23, 24, 25: Alarm Integrity Assertions
    // =========================================================================
    console.log('\n--- Test 23, 24, 25: Alarm Integrity Assertions ---');
    // 23: Linked Alarm remains UNCHANGED by Investigation lifecycle
    const recheckAlarm = await Alarm.findById(canonicalAlarm._id);
    assert(recheckAlarm.status === 'RESOLVED', `Linked Alarm status remains RESOLVED (got: ${recheckAlarm.status})`);
    assert(recheckAlarm.state === 'CLOSED', `Linked Alarm legacy state remains CLOSED (got: ${recheckAlarm.state})`);
    assert(recheckAlarm.currentSeverity === 'S4', `Linked Alarm currentSeverity remains S4 (got: ${recheckAlarm.currentSeverity})`);
    assert(recheckAlarm.highestSeverity === 'S4', `Linked Alarm highestSeverity remains S4 (got: ${recheckAlarm.highestSeverity})`);
    assert(recheckAlarm.resolvedAt?.toISOString() === canonicalAlarm.resolvedAt?.toISOString(), 'resolvedAt timestamp unchanged');
    assert(recheckAlarm.resolvedBy?.toString() === canonicalAlarm.resolvedBy?.toString(), 'resolvedBy user unchanged');

    // 24: Legacy Alarm count remains unchanged
    const finalLegacyAlarms = await Alarm.find({
      $or: [
        { lifecycleVersion: 1 },
        { lifecycleVersion: { $exists: false } },
        { lifecycleVersion: null }
      ]
    });
    assert(finalLegacyAlarms.length === 5, `Legacy alarm count in DB remains exactly 5 (got: ${finalLegacyAlarms.length})`);

    // 25: Canonical Alarm audit events remain unchanged
    const finalAlarmEventsCount = await AlarmEvent.countDocuments({ alarmId: canonicalAlarm._id });
    assert(finalAlarmEventsCount === initialAlarmEventsCount, `Canonical Alarm audit events count unchanged (${finalAlarmEventsCount} === ${initialAlarmEventsCount})`);

    // =========================================================================
    // TEST: Alarm Detail DTO & Query Support (C7B foundation)
    // =========================================================================
    console.log('\n--- Test: Alarm Detail Support for Investigations ---');
    const alarmDetail = await getAlarm({
      alarmId: canonicalAlarm._id.toString(),
      projectId: project._id,
      organizationId: project.organizationId
    });
    assert(Array.isArray(alarmDetail.investigations), 'getAlarm returns investigations array');
    assert(alarmDetail.investigations.length >= 1, `getAlarm includes linked investigation (${alarmDetail.investigations.length})`);
    assert(alarmDetail.investigations[0].investigationCode === createdInv.investigationCode, 'Alarm detail shows correct linked investigation code');

    // Query filter test: ?alarmId=...
    const filterAlarmRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/investigations?alarmId=${canonicalAlarm._id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(filterAlarmRes.status === 200, `GET /investigations?alarmId= returned HTTP 200`);
    const filteredByAlarm = await filterAlarmRes.json();
    assert(filteredByAlarm.length >= 1, `Filter by alarmId returns linked investigation`);
    assert(filteredByAlarm[0]._id === createdInv._id, `Found investigation matches created ID`);

    console.log('\n====================================================');
    console.log('ALL PHASE C7A TESTS PASSED SUCCESSFULLY (100%)');
    console.log('====================================================\n');

  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC7aVerification().catch((err) => {
  console.error('\n[FATAL ERROR]:', err);
  process.exit(1);
});
