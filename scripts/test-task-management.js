import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  User,
  Project,
  Organization,
  Team,
  TeamMember,
  ProjectMember,
  EmployeeProfile,
  Instrument,
  Device,
  Alarm,
  Investigation,
  Task,
  TaskUpdate,
  TaskEvent
} from '../src/models/index.js';
import { ROLE_PRESETS } from '../src/config/permissions.js';

function signToken(user, orgId, orgRole = 'MEMBER') {
  return jwt.sign(
    {
      sub: user._id.toString(),
      userId: user._id.toString(),
      email: user.email,
      organizationId: orgId.toString(),
      organizationRole: orgRole,
      displayName: user.displayName
    },
    env.jwtSecret,
    { expiresIn: '1h' }
  );
}

async function runTests() {
  console.log('=== Starting NexaIQ General Task Management Verification ===\n');

  await mongoose.connect(env.mongoUri);
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const runTag = `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const createdTaskIds = [];
  let project;
  let emp1User;

  const cleanupOnInterrupt = async () => {
    if (createdTaskIds.length > 0) {
      await Task.deleteMany({ _id: { $in: createdTaskIds } });
      await TaskUpdate.deleteMany({ taskId: { $in: createdTaskIds } });
      await TaskEvent.deleteMany({ taskId: { $in: createdTaskIds } });
    }
    process.exit(1);
  };
  process.once('SIGINT', cleanupOnInterrupt);
  process.once('SIGTERM', cleanupOnInterrupt);

  try {
    // 1. Setup contexts
    project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
    if (!project) throw new Error('LAN-PRO-01 project not found');
    const orgId = project.organizationId;

    // Pre-flight cleanup: remove any leftover test tasks from an earlier aborted run (never touches TASK-2026-0017)
    const priorTestTasks = await Task.find({
      projectId: project._id,
      taskCode: { $ne: 'TASK-2026-0017' },
      title: { $regex: /^TEST-TASK/i }
    }).select('_id taskCode').lean();
    if (priorTestTasks.length > 0) {
      const priorIds = priorTestTasks.map(t => t._id);
      await Task.deleteMany({ _id: { $in: priorIds } });
      await TaskUpdate.deleteMany({ taskId: { $in: priorIds } });
      await TaskEvent.deleteMany({ taskId: { $in: priorIds } });
      console.log(`[PRE-CLEANUP] Removed ${priorTestTasks.length} orphaned test tasks from prior run: ${priorTestTasks.map(t => t.taskCode).join(', ')}`);
    }

    // Users
    const adminUser = await User.findOne({ email: 'org1@yopmail.com' }).lean();
    emp1User = await User.findOne({ email: 'emp1@yopmail.com' }).lean();
    const operatorUser = await User.findOne({ email: 'operator@geonexa.test' }).lean();
    const viewerUser = await User.findOne({ email: 'viewer@geonexa.test' }).lean();

    if (!adminUser || !emp1User) throw new Error('Test users (adminUser, emp1User) not found');

    const adminToken = signToken(adminUser, orgId, 'ADMINISTRATOR');
    const emp1Token = signToken(emp1User, orgId, 'MEMBER');
    const opToken = operatorUser ? signToken(operatorUser, orgId, 'MEMBER') : null;
    const viewerToken = viewerUser ? signToken(viewerUser, orgId, 'MEMBER') : null;

    const team1 = await Team.findOne({ organizationId: orgId, teamCode: 'TEAM-0001' }).lean();
    const inst1 = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' }).lean();
    const alarm1 = await Alarm.findOne({ projectId: project._id }).lean();
    const inv1 = await Investigation.findOne({ projectId: project._id }).lean();

    // ------------------------------------------------------------------------
    // TEST 1: Task Assignment Options
    // ------------------------------------------------------------------------
    console.log('--- Test 1: GET /projects/:projectId/tasks/assignment-options ---');
    const optRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/assignment-options`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (optRes.status !== 200) throw new Error(`Expected 200 for assignment options, got ${optRes.status}`);
    const options = await optRes.json();
    if (!Array.isArray(options.eligibleTeams) || !Array.isArray(options.eligibleEmployees)) {
      throw new Error('Invalid assignment options payload shape');
    }
    console.log(`[PASS] Found ${options.eligibleTeams.length} eligible teams, ${options.eligibleEmployees.length} eligible employees.`);
    if (options.relatedObjects) {
      console.log(`[PASS] Related objects provided: ${options.relatedObjects.instruments.length} instruments, ${options.relatedObjects.devices.length} devices, ${options.relatedObjects.alarms.length} alarms, ${options.relatedObjects.investigations.length} investigations.`);
    }

    // ------------------------------------------------------------------------
    // TEST 2: Task Creation Variants & Validations
    // ------------------------------------------------------------------------
    console.log('\n--- Test 2: Task Creation Variants & Validations ---');

    // 2a: Neither Team nor Employee -> must be REJECTED with HTTP 400 (Issue 4)
    const tNeitherRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TEST-TASK-001 No Assignment [${runTag}]`,
        description: 'Should fail',
        priority: 'LOW'
      })
    });
    if (tNeitherRes.status !== 400) {
      throw new Error(`Expected HTTP 400 for task without Team or Employee, got ${tNeitherRes.status}`);
    }
    const neitherData = await tNeitherRes.json();
    console.log(`[PASS] Rejection when neither Team nor Employee provided: HTTP 400 (${neitherData.message})`);

    // 2b: Related Object Type != NONE without relatedObjectId -> must be REJECTED with HTTP 400 (Issue 1)
    const tMissingRelRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TEST-TASK-001 Missing Relation Item [${runTag}]`,
        priority: 'MEDIUM',
        assignedTeamId: team1?._id.toString(),
        relatedObjectType: 'INSTRUMENT'
      })
    });
    if (tMissingRelRes.status !== 400) {
      throw new Error(`Expected HTTP 400 for INSTRUMENT task without relatedObjectId, got ${tMissingRelRes.status}`);
    }
    console.log('[PASS] Rejection when relatedObjectType != NONE but relatedObjectId is missing: HTTP 400');

    // 2c: Team + Non-Member Employee -> must be REJECTED with HTTP 400 (Issue 3)
    // Find or test with a user not in Team-1
    const nonMember = await User.findOne({ email: 'operator@geonexa.test' }).lean() || adminUser;
    // Check if nonMember is in Team-1
    const isMember = await TeamMember.findOne({ teamId: team1._id, userId: nonMember._id, status: 'ACTIVE' });
    if (!isMember) {
      const tIncompatibleRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `TEST-TASK Incompatible Team + Employee [${runTag}]`,
          priority: 'MEDIUM',
          assignedTeamId: team1._id.toString(),
          assignedUserId: nonMember._id.toString()
        })
      });
      if (tIncompatibleRes.status !== 400) {
        throw new Error(`Expected HTTP 400 for incompatible Team + Employee, got ${tIncompatibleRes.status}`);
      }
      console.log('[PASS] Rejection when assigned employee is not an active member of assigned team: HTTP 400');
    }

    // 2d: Team-only assignment (Issue 4 valid target)
    const tTeamRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TEST-TASK-002 Team Work [${runTag}]`,
        description: 'Team-1 assigned task',
        priority: 'MEDIUM',
        assignedTeamId: team1?._id.toString(),
        relatedObjectType: 'NONE'
      })
    });
    if (tTeamRes.status !== 201) throw new Error(`Team-only task creation failed: ${tTeamRes.status}`);
    const tTeam = await tTeamRes.json();
    createdTaskIds.push(tTeam._id);
    if (tTeam.assignedUserId !== null || !tTeam.assignedTeamSnapshot?.teamName || tTeam.relatedObjectSnapshot !== null) {
      throw new Error('Team-only assignment snapshot or relation mismatch');
    }
    console.log(`[PASS] Team-only task created: ${tTeam.taskCode} -> ${tTeam.assignedTeamSnapshot.teamName} (related: —)`);

    // 2e: Employee-only assignment (Issue 4 valid target)
    const tEmpRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TEST-TASK-003 Employee Work [${runTag}]`,
        description: 'Direct employee-only assignment',
        priority: 'HIGH',
        assignedUserId: emp1User._id.toString(),
        relatedObjectType: 'NONE'
      })
    });
    if (tEmpRes.status !== 201) throw new Error(`Employee-only task creation failed: ${tEmpRes.status}`);
    const tEmp = await tEmpRes.json();
    createdTaskIds.push(tEmp._id);
    if (tEmp.assignedTeamId !== null || !tEmp.assignedUserSnapshot?.displayName) {
      throw new Error('Employee-only assignment snapshot mismatch');
    }
    console.log(`[PASS] Employee-only task created: ${tEmp.taskCode} -> ${tEmp.assignedUserSnapshot.displayName}`);

    // 2f: Team + Employee assignment with Related Instrument (Issue 1 & Issue 3)
    const tBothRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TEST-TASK-004 Inspect INC-2026-0001 mounting [${runTag}]`,
        description: 'Perform physical inspection of Automatic Inclinometer 01 mounting',
        priority: 'HIGH',
        assignedTeamId: team1?._id.toString(),
        assignedUserId: emp1User._id.toString(),
        relatedObjectType: 'INSTRUMENT',
        relatedObjectId: inst1?._id.toString()
      })
    });
    if (tBothRes.status !== 201) throw new Error(`Team + Employee task creation failed: ${tBothRes.status}`);
    const tBoth = await tBothRes.json();
    createdTaskIds.push(tBoth._id);
    if (!tBoth.assignedTeamSnapshot || !tBoth.assignedUserSnapshot || tBoth.relatedObjectType !== 'INSTRUMENT') {
      throw new Error('Team + Employee with related instrument mismatch');
    }
    if (!tBoth.relatedObjectSnapshot || tBoth.relatedObjectSnapshot.code !== inst1.code) {
      throw new Error(`Related object snapshot mismatch: expected code ${inst1.code}, got ${tBoth.relatedObjectSnapshot?.code}`);
    }
    console.log(`[PASS] Team + Employee task with related instrument created: ${tBoth.taskCode}`);
    console.log(`[PASS] Related object persisted: ${tBoth.relatedObjectSnapshot.code} / ${tBoth.relatedObjectSnapshot.name}`);

    // ------------------------------------------------------------------------
    // TEST 3: Lifecycle Transitions (OPEN -> IN_PROGRESS -> COMPLETED)
    // ------------------------------------------------------------------------
    console.log('\n--- Test 3: Task Lifecycle (OPEN -> IN_PROGRESS -> COMPLETED) ---');
    // Start task by Employee-1 (Engineer has tasks.start)
    const startRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tBoth._id}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}` }
    });
    if (startRes.status !== 200) throw new Error(`Start task failed: ${startRes.status}`);
    const startedTask = await startRes.json();
    if (startedTask.status !== 'IN_PROGRESS' || !startedTask.startedAt) {
      throw new Error('Task did not transition to IN_PROGRESS');
    }
    console.log(`[PASS] Task ${startedTask.taskCode} transitioned to IN_PROGRESS.`);

    // Cannot start again when already IN_PROGRESS -> 400
    const invalidStartRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tBoth._id}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}` }
    });
    if (invalidStartRes.status !== 400) throw new Error(`Expected 400 for restarting in-progress task, got ${invalidStartRes.status}`);
    console.log('[PASS] Cannot start already IN_PROGRESS task (rejected with HTTP 400).');

    // Add progress update by Employee-1
    const updateRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tBoth._id}/updates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Physical inspection completed. Mounting condition reviewed.',
        updateType: 'PROGRESS'
      })
    });
    if (updateRes.status !== 201) throw new Error(`Add update failed: ${updateRes.status}`);
    console.log('[PASS] Added progress update comment.');

    // Complete task by Employee-1 (Engineer has tasks.complete)
    const completeRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tBoth._id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        completionNote: 'Inspection completed successfully during NexaIQ manual workflow testing.'
      })
    });
    if (completeRes.status !== 200) throw new Error(`Complete task failed: ${completeRes.status}`);
    const completedTask = await completeRes.json();
    if (completedTask.status !== 'COMPLETED' || !completedTask.completedAt || !completedTask.completionNote) {
      throw new Error('Task did not transition to COMPLETED');
    }
    console.log(`[PASS] Task ${completedTask.taskCode} transitioned to COMPLETED.`);

    // Terminal check: Cannot start or edit completed task -> 400
    const startCompletedRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tBoth._id}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}` }
    });
    if (startCompletedRes.status !== 400) throw new Error('Expected 400 when starting completed task');
    console.log('[PASS] Completed task is terminal read-only historical record.');

    // ------------------------------------------------------------------------
    // TEST 4: Cancellation Lifecycle (OPEN -> CANCELLED)
    // ------------------------------------------------------------------------
    console.log('\n--- Test 4: Task Cancellation (OPEN -> CANCELLED) ---');
    // Admin cancels tTeam
    const cancelRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tTeam._id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancellationReason: 'Work no longer required' })
    });
    if (cancelRes.status !== 200) throw new Error(`Cancel task failed: ${cancelRes.status}`);
    const cancelledTask = await cancelRes.json();
    if (cancelledTask.status !== 'CANCELLED' || !cancelledTask.cancelledAt) {
      throw new Error('Task did not transition to CANCELLED');
    }
    console.log(`[PASS] Task ${cancelledTask.taskCode} transitioned to CANCELLED.`);

    // ------------------------------------------------------------------------
    // TEST 5: Audit Events Verification
    // ------------------------------------------------------------------------
    console.log('\n--- Test 5: Audit Events Verification ---');
    const eventsRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tBoth._id}/events`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const events = await eventsRes.json();
    const eventTypes = events.map(e => e.eventType);
    console.log('Event types recorded:', eventTypes);
    if (!eventTypes.includes('CREATED') ||
        !eventTypes.includes('ASSIGNED') ||
        !eventTypes.includes('STARTED') ||
        !eventTypes.includes('UPDATED') ||
        !eventTypes.includes('COMPLETED')) {
      throw new Error(`Missing expected audit event types: ${eventTypes.join(', ')}`);
    }
    console.log('[PASS] Audit trail contains CREATED, ASSIGNED, STARTED, UPDATED, COMPLETED.');

    // ------------------------------------------------------------------------
    // TEST 6: Filtering & "My Tasks"
    // ------------------------------------------------------------------------
    console.log('\n--- Test 6: Filtering & My Tasks ---');
    // My Tasks for emp1
    const myTasksRes = await fetch(`${baseUrl}/projects/${project._id}/tasks?myTasks=true`, {
      headers: { Authorization: `Bearer ${emp1Token}` }
    });
    const myTasksData = await myTasksRes.json();
    const myTaskIds = myTasksData.tasks.map(t => t._id);
    if (!myTaskIds.includes(tBoth._id) || !myTaskIds.includes(tEmp._id)) {
      throw new Error('My Tasks missing directly assigned tasks for Employee-1');
    }
    if (myTaskIds.includes(tTeam._id)) {
      throw new Error('My Tasks must NOT include Team-only task when employee was not individually assigned');
    }
    console.log('[PASS] "My Tasks" returns only tasks directly assigned to employee.');

    // Team Filter
    const teamFilterRes = await fetch(`${baseUrl}/projects/${project._id}/tasks?assignedTeamId=${team1._id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const teamFilterData = await teamFilterRes.json();
    const teamTaskIds = teamFilterData.tasks.map(t => t._id);
    if (!teamTaskIds.includes(tTeam._id) || !teamTaskIds.includes(tBoth._id)) {
      throw new Error('Team filter missing tasks assigned to Team-1');
    }
    console.log('[PASS] Team filter matches both Team-only and Team+Employee tasks.');

    // Counters
    if (myTasksData.counters === undefined || myTasksData.counters.completed < 1) {
      throw new Error('Counters missing or completed count incorrect');
    }
    console.log(`[PASS] Counters verified: OPEN=${myTasksData.counters.open}, IN_PROGRESS=${myTasksData.counters.inProgress}, COMPLETED=${myTasksData.counters.completed}, OVERDUE=${myTasksData.counters.overdue}`);

    // ------------------------------------------------------------------------
    // TEST 7: Role Permission Matrix Enforcement
    // ------------------------------------------------------------------------
    console.log('\n--- Test 7: Role-Based Task Permission Enforcement ---');

    // 7a: Engineer cannot create task by default (Issue 2)
    const engCreateRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TEST-TASK Engineer Unauthorized Task [${runTag}]`,
        assignedTeamId: team1._id.toString()
      })
    });
    if (engCreateRes.status !== 403) throw new Error(`Expected 403 for Engineer tasks.create, got ${engCreateRes.status}`);
    console.log('[PASS] Default ENGINEER cannot create task (rejected with HTTP 403).');

    // 7b: CUSTOM Employee Access test: Explicitly grant tasks.create to Engineer (Issue 2)
    const customPerms = [...ROLE_PRESETS.ENGINEER, 'tasks.create'];
    const patchCustomRes = await fetch(`${baseUrl}/projects/${project._id}/employee-access/${emp1User._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'ENGINEER',
        accessProfile: 'CUSTOM',
        permissions: customPerms
      })
    });
    if (patchCustomRes.status !== 200) throw new Error('Failed to set CUSTOM access for Engineer');

    const customCreateRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TEST-TASK Custom Engineer Task [${runTag}]`,
        assignedTeamId: team1._id.toString()
      })
    });
    if (customCreateRes.status !== 201) throw new Error(`Expected 201 for CUSTOM Engineer with tasks.create, got ${customCreateRes.status}`);
    const customTask = await customCreateRes.json();
    createdTaskIds.push(customTask._id);
    console.log('[PASS] CUSTOM Engineer with explicitly granted tasks.create successfully creates task (HTTP 201).');

    // Reset Engineer back to ROLE_PRESET
    await fetch(`${baseUrl}/projects/${project._id}/employee-access/${emp1User._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'ENGINEER',
        permissions: [...ROLE_PRESETS.ENGINEER]
      })
    });

    // 7c: Engineer cannot assign or cancel
    const engAssignRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tEmp._id}/assign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedUserId: adminUser._id.toString() })
    });
    if (engAssignRes.status !== 403) throw new Error(`Expected 403 for Engineer tasks.assign, got ${engAssignRes.status}`);
    console.log('[PASS] Engineer tasks.assign rejected with HTTP 403.');

    const engCancelRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tEmp._id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancellationReason: 'Test' })
    });
    if (engCancelRes.status !== 403) throw new Error(`Expected 403 for Engineer tasks.cancel, got ${engCancelRes.status}`);
    console.log('[PASS] Engineer tasks.cancel rejected with HTTP 403.');

    // 7b: Operator cannot create or assign or cancel, but can view and start
    if (opToken) {
      const opCreateRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `TEST-TASK Operator Task Attempt [${runTag}]` })
      });
      if (opCreateRes.status !== 403) throw new Error(`Expected 403 for Operator tasks.create, got ${opCreateRes.status}`);
      console.log('[PASS] Operator tasks.create rejected with HTTP 403.');
    }

    // 7c: Viewer is read-only (mutations rejected with 403)
    if (viewerToken) {
      const viewCreateRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `TEST-TASK Viewer Task Attempt [${runTag}]` })
      });
      if (viewCreateRes.status !== 403) throw new Error(`Expected 403 for Viewer tasks.create, got ${viewCreateRes.status}`);

      const viewStartRes = await fetch(`${baseUrl}/projects/${project._id}/tasks/${tEmp._id}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerToken}` }
      });
      if (viewStartRes.status !== 403) throw new Error(`Expected 403 for Viewer tasks.start, got ${viewStartRes.status}`);

      const viewListRes = await fetch(`${baseUrl}/projects/${project._id}/tasks`, {
        headers: { Authorization: `Bearer ${viewerToken}` }
      });
      if (viewListRes.status !== 200) throw new Error(`Expected 200 for Viewer tasks.view, got ${viewListRes.status}`);
      console.log('[PASS] Viewer can view tasks (200) but cannot create or start tasks (403).');
    }

    // ------------------------------------------------------------------------
    // TEST 8: Organization & Project Isolation
    // ------------------------------------------------------------------------
    console.log('\n--- Test 8: Organization & Project Scoping & Isolation ---');
    const fakeProjId = new mongoose.Types.ObjectId();
    const foreignRes = await fetch(`${baseUrl}/projects/${fakeProjId}/tasks`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (foreignRes.status !== 404 && foreignRes.status !== 403) {
      throw new Error(`Expected 404/403 for foreign project, got ${foreignRes.status}`);
    }
    console.log('[PASS] Foreign project queries are strictly denied/isolated.');

    // ------------------------------------------------------------------------
    // TEST 9: Domain Non-Regression & Safety
    // ------------------------------------------------------------------------
    const finalProject = await Project.findById(project._id).lean();
    const effectiveAccessMode = finalProject.accessMode || 'ROLE_BASED';
    if (effectiveAccessMode !== 'ROLE_BASED') {
      throw new Error(`Project accessMode changed to ${finalProject.accessMode}`);
    }
    console.log('[PASS] LAN-PRO-01 remains in ROLE_BASED mode.');

    console.log('\n======================================================');
    console.log('ALL GENERAL TASK MANAGEMENT BACKEND TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    // 1. Task test records cleanup: delete ONLY the created test task IDs and their updates/events
    if (createdTaskIds.length > 0) {
      try {
        const deletedTasks = await Task.deleteMany({ _id: { $in: createdTaskIds } });
        const deletedUpdates = await TaskUpdate.deleteMany({ taskId: { $in: createdTaskIds } });
        const deletedEvents = await TaskEvent.deleteMany({ taskId: { $in: createdTaskIds } });
        console.log(`[CLEANUP] Deleted ${deletedTasks.deletedCount} test task(s), ${deletedUpdates.deletedCount} update(s), and ${deletedEvents.deletedCount} event(s).`);
      } catch (cleanupErr) {
        console.error('[CLEANUP ERROR] Failed to clean up test tasks:', cleanupErr);
      }
    }

    // 2. Revert any employee access changes if modified
    try {
      if (project?._id && emp1User?._id) {
        await ProjectMember.updateOne(
          { projectId: project._id, userId: emp1User._id },
          { $set: { accessProfile: 'ROLE_PRESET', permissions: [] } }
        );
      }
    } catch (resetErr) {
      console.error('[CLEANUP ERROR] Failed to reset employee access:', resetErr);
    }

    // 3. Gracefully close server and DB connection
    try {
      if (server) server.close();
    } catch (_) {}
    try {
      await mongoose.disconnect();
    } catch (_) {}
  }
}

runTests().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
