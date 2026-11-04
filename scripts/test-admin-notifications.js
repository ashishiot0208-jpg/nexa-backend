import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import assert from 'node:assert';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  User,
  Project,
  Organization,
  ProjectMember,
  OrganizationMember,
  Alarm,
  AlarmEvent,
  Task,
  TaskEvent,
  TaskUpdate,
  Investigation,
  InvestigationEvent,
  Notification
} from '../src/models/index.js';
import {
  createAlarm
} from '../src/services/alarm.service.js';
import {
  createTask,
  completeTask
} from '../src/services/task.service.js';
import {
  completeInvestigation
} from '../src/services/investigation.service.js';
import {
  checkAndNotifyOverdueTasks
} from '../src/services/notification.service.js';

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
  console.log('=== Starting NexaIQ Phase 1 — Administrator Notifications Verification ===\n');

  await mongoose.connect(env.mongoUri);
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const runTag = `NOTIF-TEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // Track created entities for thorough cleanup
  const createdUserIds = [];
  const createdOrgIds = [];
  const createdProjectIds = [];
  const createdAlarmIds = [];
  const createdTaskIds = [];
  const createdInvestigationIds = [];
  const createdNotificationIds = [];

  const cleanup = async () => {
    console.log('\n[CLEANUP] Cleaning up test records...');
    try {
      if (createdNotificationIds.length) {
        await Notification.deleteMany({ _id: { $in: createdNotificationIds } });
      }
      await Notification.deleteMany({ dedupeKey: { $regex: runTag } });

      if (createdTaskIds.length) {
        await Task.deleteMany({ _id: { $in: createdTaskIds } });
        await TaskEvent.deleteMany({ taskId: { $in: createdTaskIds } });
        await TaskUpdate.deleteMany({ taskId: { $in: createdTaskIds } });
      }
      if (createdInvestigationIds.length) {
        await Investigation.deleteMany({ _id: { $in: createdInvestigationIds } });
        await InvestigationEvent.deleteMany({ investigationId: { $in: createdInvestigationIds } });
      }
      if (createdAlarmIds.length) {
        await Alarm.deleteMany({ _id: { $in: createdAlarmIds } });
        await AlarmEvent.deleteMany({ alarmId: { $in: createdAlarmIds } });
      }
      if (createdUserIds.length) {
        await User.deleteMany({ _id: { $in: createdUserIds } });
        await OrganizationMember.deleteMany({ userId: { $in: createdUserIds } });
        await ProjectMember.deleteMany({ userId: { $in: createdUserIds } });
      }
      if (createdProjectIds.length) {
        await Project.deleteMany({ _id: { $in: createdProjectIds } });
      }
      if (createdOrgIds.length) {
        await Organization.deleteMany({ _id: { $in: createdOrgIds } });
      }
      console.log('[CLEANUP] Finished cleanly.');
    } catch (cleanErr) {
      console.error('[CLEANUP] Error cleaning up:', cleanErr);
    }
  };

  process.once('SIGINT', async () => {
    await cleanup();
    server.close();
    process.exit(1);
  });

  try {
    // -------------------------------------------------------------------------
    // Setup Primary Organization & Project
    // -------------------------------------------------------------------------
    const primaryOrg = await Organization.create({
      name: `Test Org ${runTag}`,
      code: `TORG-${Date.now().toString().slice(-6)}`,
      status: 'ACTIVE'
    });
    createdOrgIds.push(primaryOrg._id);

    const primaryProject = await Project.create({
      organizationId: primaryOrg._id,
      name: `Test Project ${runTag}`,
      code: `TPROJ-${Date.now().toString().slice(-6)}`,
      accessMode: 'ROLE_BASED',
      status: 'ACTIVE'
    });
    createdProjectIds.push(primaryProject._id);

    // Setup Foreign Organization & Project (for cross-org / cross-project isolation tests)
    const foreignOrg = await Organization.create({
      name: `Foreign Org ${runTag}`,
      code: `FORG-${Date.now().toString().slice(-6)}`,
      status: 'ACTIVE'
    });
    createdOrgIds.push(foreignOrg._id);

    const foreignProject = await Project.create({
      organizationId: foreignOrg._id,
      name: `Foreign Project ${runTag}`,
      code: `FPROJ-${Date.now().toString().slice(-6)}`,
      accessMode: 'ROLE_BASED',
      status: 'ACTIVE'
    });
    createdProjectIds.push(foreignProject._id);

    // Admin User 1 (Project Member with role ADMINISTRATOR, Org Role ADMINISTRATOR)
    const adminUser1 = await User.create({
      email: `admin1-${runTag.toLowerCase()}@test.com`,
      displayName: 'Admin User 1',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(adminUser1._id);

    await OrganizationMember.create({
      organizationId: primaryOrg._id,
      userId: adminUser1._id,
      organizationRole: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: primaryProject._id,
      userId: adminUser1._id,
      role: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });

    // Admin User 2 (Project Administrator with Org Role ENGINEER - tests project-level admin role)
    const adminUser2 = await User.create({
      email: `admin2-${runTag.toLowerCase()}@test.com`,
      displayName: 'Admin User 2',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(adminUser2._id);

    await OrganizationMember.create({
      organizationId: primaryOrg._id,
      userId: adminUser2._id,
      organizationRole: 'ENGINEER',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: primaryProject._id,
      userId: adminUser2._id,
      role: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });

    // Engineer User (Not an Admin)
    const engineerUser = await User.create({
      email: `eng-${runTag.toLowerCase()}@test.com`,
      displayName: 'Engineer User',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(engineerUser._id);

    await OrganizationMember.create({
      organizationId: primaryOrg._id,
      userId: engineerUser._id,
      organizationRole: 'ENGINEER',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: primaryProject._id,
      userId: engineerUser._id,
      role: 'ENGINEER',
      status: 'ACTIVE'
    });

    // Foreign Admin User (Admin in foreignOrg / foreignProject)
    const foreignAdmin = await User.create({
      email: `fadmin-${runTag.toLowerCase()}@test.com`,
      displayName: 'Foreign Admin',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(foreignAdmin._id);

    await OrganizationMember.create({
      organizationId: foreignOrg._id,
      userId: foreignAdmin._id,
      organizationRole: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: foreignProject._id,
      userId: foreignAdmin._id,
      role: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });

    // Tokens
    const adminToken1 = signToken(adminUser1, primaryOrg._id, 'ADMINISTRATOR');
    const adminToken2 = signToken(adminUser2, primaryOrg._id, 'ENGINEER');
    const engineerToken = signToken(engineerUser, primaryOrg._id, 'ENGINEER');
    const foreignAdminToken = signToken(foreignAdmin, foreignOrg._id, 'ADMINISTRATOR');

    console.log('[SETUP] Test fixture created successfully.');

    // =========================================================================
    // SECTION 1: Notification APIs
    // =========================================================================
    console.log('\n--- Section 1: Notification APIs ---');

    // Create 3 seed notifications for Admin 1 (2 UNREAD, 1 READ)
    const notif1 = await Notification.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      recipientUserId: adminUser1._id,
      type: 'ADMIN_TASK_COMPLETED',
      title: 'Task Alpha completed',
      message: 'TASK-1 was completed',
      importance: 'NORMAL',
      relatedObjectType: 'TASK',
      relatedObjectId: new mongoose.Types.ObjectId(),
      isRead: false,
      dedupeKey: `MANUAL_1:${runTag}`
    });
    createdNotificationIds.push(notif1._id);

    const notif2 = await Notification.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      recipientUserId: adminUser1._id,
      type: 'ADMIN_S4_ALARM',
      title: 'Critical S4 alarm triggered',
      message: 'INC-01 reached S4',
      importance: 'CRITICAL',
      relatedObjectType: 'ALARM',
      relatedObjectId: new mongoose.Types.ObjectId(),
      isRead: false,
      dedupeKey: `MANUAL_2:${runTag}`
    });
    createdNotificationIds.push(notif2._id);

    const notif3 = await Notification.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      recipientUserId: adminUser1._id,
      type: 'ADMIN_TASK_OVERDUE',
      title: 'Task Beta overdue',
      message: 'TASK-2 is overdue',
      importance: 'IMPORTANT',
      relatedObjectType: 'TASK',
      relatedObjectId: new mongoose.Types.ObjectId(),
      isRead: true,
      readAt: new Date(),
      dedupeKey: `MANUAL_3:${runTag}`
    });
    createdNotificationIds.push(notif3._id);

    // Notification for Admin 2
    const notifAdmin2 = await Notification.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      recipientUserId: adminUser2._id,
      type: 'ADMIN_TASK_COMPLETED',
      title: 'Admin2 only notification',
      message: 'Exclusive to admin2',
      importance: 'NORMAL',
      relatedObjectType: 'TASK',
      relatedObjectId: new mongoose.Types.ObjectId(),
      isRead: false,
      dedupeKey: `MANUAL_ADMIN2:${runTag}`
    });
    createdNotificationIds.push(notifAdmin2._id);

    // 1. Administrator can list own notifications
    const listRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications`, {
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    assert.strictEqual(listRes.status, 200, 'GET /notifications returns 200');
    const listData = await listRes.json();
    assert(Array.isArray(listData), 'GET /notifications returns array');
    assert.strictEqual(listData.length, 3, 'Admin 1 sees exactly their 3 notifications');
    assert(listData.every(n => n.recipientUserId.toString() === adminUser1._id.toString()), 'All notifications belong to Admin 1');
    console.log('[PASS] 1. Administrator can list own notifications.');

    // 2. Unread count works
    const countRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    assert.strictEqual(countRes.status, 200, 'GET /unread-count returns 200');
    const countData = await countRes.json();
    assert.strictEqual(countData.count, 2, 'Unread count is 2 (2 unread, 1 read)');
    assert.strictEqual(countData.unreadCount, 2, 'unreadCount alias matches count');
    console.log('[PASS] 2. Unread count works.');

    // 3. Mark one notification read (via PATCH and POST)
    const markReadRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/${notif1._id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    assert.strictEqual(markReadRes.status, 200, 'PATCH /:id/read returns 200');
    const markReadData = await markReadRes.json();
    assert.strictEqual(markReadData.isRead, true, 'isRead is updated to true');
    assert(markReadData.readAt !== null, 'readAt is populated');

    // Verify unread count decreased to 1
    const countResAfterOne = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    const countAfterOne = await countResAfterOne.json();
    assert.strictEqual(countAfterOne.count, 1, 'Unread count decremented to 1');
    console.log('[PASS] 3. Mark one notification read.');

    // 4. Mark all notifications read
    const markAllRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/mark-all-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    assert.strictEqual(markAllRes.status, 200, 'POST /mark-all-read returns 200');
    const markAllData = await markAllRes.json();
    assert.strictEqual(markAllData.success, true, 'Mark all returns success: true');

    const countResAfterAll = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    const countAfterAll = await countResAfterAll.json();
    assert.strictEqual(countAfterAll.count, 0, 'Unread count is now 0');

    // Admin 2's unread notification should be unaffected
    const countAdmin2Res = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${adminToken2}` }
    });
    const countAdmin2 = await countAdmin2Res.json();
    assert.strictEqual(countAdmin2.count, 1, 'Admin 2 unread count remains 1');
    console.log('[PASS] 4. Mark all notifications read.');

    // 5. User cannot access another user's notification
    const crossUserReadRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/${notifAdmin2._id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    assert.strictEqual(crossUserReadRes.status, 403, 'Cross-user mark-read returns HTTP 403 Forbidden');
    console.log('[PASS] 5. User cannot access another user\'s notification.');

    // 6. Cross-project access is blocked
    const crossProjListRes = await fetch(`${baseUrl}/projects/${foreignProject._id}/notifications`, {
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    assert(crossProjListRes.status === 403 || crossProjListRes.status === 404, 'Cross-project access rejected with 403/404');

    const crossProjReadRes = await fetch(`${baseUrl}/projects/${foreignProject._id}/notifications/${notif1._id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken1}` }
    });
    assert(crossProjReadRes.status === 403 || crossProjReadRes.status === 404, 'Cross-project mark-read rejected');
    console.log('[PASS] 6. Cross-project access is blocked.');

    // 7. Cross-organization access is blocked
    const crossOrgListRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications`, {
      headers: { Authorization: `Bearer ${foreignAdminToken}` }
    });
    assert(crossOrgListRes.status === 403 || crossOrgListRes.status === 404, 'Foreign org admin blocked from primary project');
    console.log('[PASS] 7. Cross-organization access is blocked.');

    // Non-admin role blocked from admin inbox
    const engListRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications`, {
      headers: { Authorization: `Bearer ${engineerToken}` }
    });
    assert.strictEqual(engListRes.status, 403, 'Engineer blocked from Administrator notification inbox');
    console.log('[PASS] Non-admin project role strictly blocked from notification inbox.');

    // =========================================================================
    // SECTION 2: S4 Alarm Event Trigger & Deduplication
    // =========================================================================
    console.log('\n--- Section 2: S4 Alarm Trigger ---');

    // 8. New S4 Alarm creates Administrator notification
    const s4AlarmResult = await createAlarm({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      category: 'ENGINEERING_SEVERITY',
      title: `INC-${runTag} · X Displacement S4 Test`,
      parameterCode: 'displacement_x',
      initialSeverity: 'S4',
      reason: 'THRESHOLD_S4_EXCEEDED'
    });
    assert.strictEqual(s4AlarmResult.isDuplicate, false, 'New S4 alarm created');
    createdAlarmIds.push(s4AlarmResult.alarm._id);

    // Check notifications created for Admin 1 and Admin 2
    const s4Notifs = await Notification.find({
      relatedObjectId: s4AlarmResult.alarm._id,
      type: 'ADMIN_S4_ALARM'
    }).lean();
    for (const n of s4Notifs) createdNotificationIds.push(n._id);

    assert.strictEqual(s4Notifs.length, 2, 'Exactly 2 notifications created (one per eligible admin)');
    const adminIdsInNotif = s4Notifs.map(n => n.recipientUserId.toString());
    assert(adminIdsInNotif.includes(adminUser1._id.toString()), 'Admin 1 received S4 notification');
    assert(adminIdsInNotif.includes(adminUser2._id.toString()), 'Admin 2 received S4 notification');
    assert.strictEqual(s4Notifs[0].importance, 'CRITICAL', 'Importance is CRITICAL');
    assert.strictEqual(s4Notifs[0].relatedObjectType, 'ALARM', 'relatedObjectType is ALARM');
    assert.strictEqual(s4Notifs[0].relatedObjectSnapshot.currentSeverity, 'S4', 'Snapshot includes currentSeverity S4');
    console.log('[PASS] 8. New S4 Alarm creates Administrator notification.');

    // 9. S1/S2/S3 do not create Phase-1 critical notification
    const s2AlarmResult = await createAlarm({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      category: 'ENGINEERING_SEVERITY',
      title: `INC-${runTag} · Y Displacement S2 Test`,
      parameterCode: 'displacement_y',
      initialSeverity: 'S2',
      reason: 'THRESHOLD_S2_EXCEEDED'
    });
    createdAlarmIds.push(s2AlarmResult.alarm._id);

    const s2Notifs = await Notification.find({
      relatedObjectId: s2AlarmResult.alarm._id
    }).lean();
    assert.strictEqual(s2Notifs.length, 0, 'No notifications created for S2 alarm');
    console.log('[PASS] 9. S1/S2/S3 do not create Phase-1 critical notification.');

    // 10. Existing active S4 Alarm evaluation does not duplicate notification
    const s4DupResult = await createAlarm({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      category: 'ENGINEERING_SEVERITY',
      title: `INC-${runTag} · X Displacement S4 Test Duplicate Attempt`,
      parameterCode: 'displacement_x',
      initialSeverity: 'S4',
      reason: 'THRESHOLD_S4_EXCEEDED'
    });
    assert.strictEqual(s4DupResult.isDuplicate, true, 'Deduplication detected active alarm');

    const s4NotifsAfterDup = await Notification.find({
      relatedObjectId: s4AlarmResult.alarm._id,
      type: 'ADMIN_S4_ALARM'
    }).lean();
    assert.strictEqual(s4NotifsAfterDup.length, 2, 'No duplicate notification generated on existing active S4 alarm evaluation');
    console.log('[PASS] 10. Existing active S4 Alarm evaluation does not duplicate notification.');

    // 11. Multiple eligible Administrators each receive their own notification
    assert.strictEqual(new Set(adminIdsInNotif).size, 2, 'Each Administrator received their own distinct record');
    assert(s4Notifs[0]._id.toString() !== s4Notifs[1]._id.toString(), 'Distinct notification IDs');
    console.log('[PASS] 11. Multiple eligible Administrators each receive their own notification.');

    // =========================================================================
    // SECTION 3: Task Completed Event Trigger
    // =========================================================================
    console.log('\n--- Section 3: Task Completed Trigger ---');

    // Create a task and transition it OPEN -> IN_PROGRESS -> COMPLETED
    const testTask = await createTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Inspection Task ${runTag}`,
      description: 'Perform visual inspection',
      priority: 'HIGH',
      assignedUserId: engineerUser._id,
      actor: { userId: adminUser1._id, displayName: 'Admin User 1' }
    });
    createdTaskIds.push(testTask._id);

    // Transition to IN_PROGRESS
    testTask.status = 'IN_PROGRESS';
    await testTask.save();

    // 12. Complete the task
    const completedTask = await completeTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      taskId: testTask._id,
      completionNote: 'Inspection successfully completed by engineer',
      actor: { userId: engineerUser._id, displayName: 'Engineer User', email: engineerUser.email }
    });
    assert.strictEqual(completedTask.status, 'COMPLETED', 'Task status is COMPLETED');

    const taskNotifs = await Notification.find({
      relatedObjectId: testTask._id,
      type: 'ADMIN_TASK_COMPLETED'
    }).lean();
    for (const n of taskNotifs) createdNotificationIds.push(n._id);

    assert.strictEqual(taskNotifs.length, 2, 'Both Admins notified of task completion');
    console.log('[PASS] 12. Task completion creates Administrator notification.');

    // 13. Notification contains useful Task/employee metadata
    const sampleTaskNotif = taskNotifs[0];
    assert.strictEqual(sampleTaskNotif.importance, 'NORMAL', 'Importance is NORMAL');
    assert.strictEqual(sampleTaskNotif.relatedObjectType, 'TASK', 'relatedObjectType is TASK');
    assert.strictEqual(sampleTaskNotif.title, 'Task completed', 'Title is "Task completed"');
    assert(sampleTaskNotif.message.includes('completed by Engineer User'), 'Message references completing user');
    assert.strictEqual(sampleTaskNotif.relatedObjectSnapshot.completedBy, 'Engineer User', 'Snapshot has completedBy');
    assert.strictEqual(sampleTaskNotif.relatedObjectSnapshot.priority, 'HIGH', 'Snapshot has priority');
    assert(sampleTaskNotif.relatedObjectSnapshot.completedAt !== null, 'Snapshot has completedAt');
    console.log('[PASS] 13. Notification contains useful Task/employee metadata.');

    // 14. Duplicate completion attempt does not duplicate notification
    let secondCompleteError = null;
    try {
      await completeTask({
        organizationId: primaryOrg._id,
        projectId: primaryProject._id,
        taskId: testTask._id,
        completionNote: 'Second attempt',
        actor: { userId: engineerUser._id, displayName: 'Engineer User' }
      });
    } catch (err) {
      secondCompleteError = err;
    }
    assert(secondCompleteError !== null, 'Re-completing an already completed task throws error');
    const taskNotifsAfterAttempt = await Notification.find({
      relatedObjectId: testTask._id,
      type: 'ADMIN_TASK_COMPLETED'
    }).lean();
    assert.strictEqual(taskNotifsAfterAttempt.length, 2, 'Notification count remains exactly 2');
    console.log('[PASS] 14. Duplicate completion attempt does not duplicate notification.');

    // =========================================================================
    // SECTION 4: Investigation Completed Event Trigger
    // =========================================================================
    console.log('\n--- Section 4: Investigation Completed Trigger ---');

    // Create an investigation in IN_PROGRESS state
    const testInv = await Investigation.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Slope Stability Investigation ${runTag}`,
      description: 'Investigating movement anomaly',
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      lifecycleVersion: 1
    });
    createdInvestigationIds.push(testInv._id);

    // 15. Complete investigation
    const completedInv = await completeInvestigation({
      investigationId: testInv._id,
      projectId: primaryProject._id,
      organizationId: primaryOrg._id,
      conclusion: 'Soil saturation normalized after drainage clear',
      rootCause: 'Surface drainage blockage',
      recommendedAction: 'Install automated pump',
      actor: { userId: engineerUser._id, displayName: 'Engineer User' }
    });
    assert.strictEqual(completedInv.status, 'COMPLETED', 'Investigation is COMPLETED');

    const invNotifs = await Notification.find({
      relatedObjectId: testInv._id,
      type: 'ADMIN_INVESTIGATION_COMPLETED'
    }).lean();
    for (const n of invNotifs) createdNotificationIds.push(n._id);

    assert.strictEqual(invNotifs.length, 2, 'Both Admins notified of investigation completion');
    assert.strictEqual(invNotifs[0].importance, 'IMPORTANT', 'Importance is IMPORTANT');
    assert.strictEqual(invNotifs[0].relatedObjectType, 'INVESTIGATION', 'relatedObjectType is INVESTIGATION');
    assert(invNotifs[0].message.includes('was completed by Engineer User'), 'Message references completing user');
    console.log('[PASS] 15. Investigation completion creates Administrator notification.');

    // 16. Duplicate completion attempt does not duplicate notification
    let secondInvError = null;
    try {
      await completeInvestigation({
        investigationId: testInv._id,
        projectId: primaryProject._id,
        organizationId: primaryOrg._id,
        conclusion: 'Another conclusion',
        actor: { userId: engineerUser._id, displayName: 'Engineer User' }
      });
    } catch (err) {
      secondInvError = err;
    }
    assert(secondInvError !== null, 'Re-completing an already completed investigation throws error');
    const invNotifsAfterAttempt = await Notification.find({
      relatedObjectId: testInv._id,
      type: 'ADMIN_INVESTIGATION_COMPLETED'
    }).lean();
    assert.strictEqual(invNotifsAfterAttempt.length, 2, 'No duplicate notification created');
    console.log('[PASS] 16. Duplicate completion attempt does not duplicate notification.');

    // =========================================================================
    // SECTION 5: Task Overdue Detection & Scheduling
    // =========================================================================
    console.log('\n--- Section 5: Task Overdue Detection ---');

    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day future

    // 17. OPEN overdue task
    const openOverdueTask = await Task.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Open Overdue Task ${runTag}`,
      status: 'OPEN',
      priority: 'HIGH',
      dueDate: pastDate
    });
    createdTaskIds.push(openOverdueTask._id);

    // 18. IN_PROGRESS overdue task
    const inProgressOverdueTask = await Task.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `In Progress Overdue Task ${runTag}`,
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      dueDate: pastDate
    });
    createdTaskIds.push(inProgressOverdueTask._id);

    // 19. COMPLETED task with past dueDate (should NOT trigger overdue notification)
    const completedPastTask = await Task.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Completed Past Task ${runTag}`,
      status: 'COMPLETED',
      priority: 'LOW',
      dueDate: pastDate,
      completedAt: new Date()
    });
    createdTaskIds.push(completedPastTask._id);

    // 20. CANCELLED task with past dueDate (should NOT trigger overdue notification)
    const cancelledPastTask = await Task.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Cancelled Past Task ${runTag}`,
      status: 'CANCELLED',
      priority: 'LOW',
      dueDate: pastDate
    });
    createdTaskIds.push(cancelledPastTask._id);

    // Task that is not overdue (dueDate in future)
    const futureTask = await Task.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Future Task ${runTag}`,
      status: 'OPEN',
      priority: 'LOW',
      dueDate: futureDate
    });
    createdTaskIds.push(futureTask._id);

    // Run overdue scan for this project
    const scanResult = await checkAndNotifyOverdueTasks({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id
    });
    assert.strictEqual(scanResult.scanned, 2, 'Scanned exactly 2 overdue tasks (OPEN and IN_PROGRESS with dueDate < now)');

    // Check OPEN overdue notifications
    const openOverdueNotifs = await Notification.find({
      relatedObjectId: openOverdueTask._id,
      type: 'ADMIN_TASK_OVERDUE'
    }).lean();
    for (const n of openOverdueNotifs) createdNotificationIds.push(n._id);
    assert.strictEqual(openOverdueNotifs.length, 2, 'OPEN overdue task notified both Admins');
    console.log('[PASS] 17. OPEN overdue Task creates notification.');

    // Check IN_PROGRESS overdue notifications
    const inProgressOverdueNotifs = await Notification.find({
      relatedObjectId: inProgressOverdueTask._id,
      type: 'ADMIN_TASK_OVERDUE'
    }).lean();
    for (const n of inProgressOverdueNotifs) createdNotificationIds.push(n._id);
    assert.strictEqual(inProgressOverdueNotifs.length, 2, 'IN_PROGRESS overdue task notified both Admins');
    console.log('[PASS] 18. IN_PROGRESS overdue Task creates notification.');

    // Check COMPLETED task did not trigger overdue notification
    const completedOverdueNotifs = await Notification.find({
      relatedObjectId: completedPastTask._id,
      type: 'ADMIN_TASK_OVERDUE'
    }).lean();
    assert.strictEqual(completedOverdueNotifs.length, 0, 'COMPLETED task with past dueDate generates 0 overdue notifications');
    console.log('[PASS] 19. COMPLETED Task does not create overdue notification.');

    // Check CANCELLED task did not trigger overdue notification
    const cancelledOverdueNotifs = await Notification.find({
      relatedObjectId: cancelledPastTask._id,
      type: 'ADMIN_TASK_OVERDUE'
    }).lean();
    assert.strictEqual(cancelledOverdueNotifs.length, 0, 'CANCELLED task with past dueDate generates 0 overdue notifications');
    console.log('[PASS] 20. CANCELLED Task does not create overdue notification.');

    // 21. Repeated overdue scan does not duplicate notification
    const scan2Result = await checkAndNotifyOverdueTasks({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id
    });
    assert.strictEqual(scan2Result.scanned, 2, 'Second scan scanned same 2 tasks');
    assert.strictEqual(scan2Result.notified, 0, 'Second scan created 0 new notifications due to deduplication');

    const totalOpenOverdue = await Notification.countDocuments({
      relatedObjectId: openOverdueTask._id,
      type: 'ADMIN_TASK_OVERDUE'
    });
    assert.strictEqual(totalOpenOverdue, 2, 'Total overdue notifications for open task remains 2');
    console.log('[PASS] 21. Repeated overdue scan does not duplicate notification.');

    // =========================================================================
    // SECTION 6: Failure Isolation
    // =========================================================================
    console.log('\n--- Section 6: Failure Isolation ---');

    // 22. Simulate notification creation failure by monkey-patching Notification.create
    const originalCreate = Notification.create;
    Notification.create = async () => {
      throw new Error('Simulated database write failure for notification');
    };

    let simulatedTaskCompletedSuccess = false;
    try {
      const isolationTask = await Task.create({
        organizationId: primaryOrg._id,
        projectId: primaryProject._id,
        title: `Isolation Task ${runTag}`,
        status: 'IN_PROGRESS',
        priority: 'MEDIUM'
      });
      createdTaskIds.push(isolationTask._id);

      // 23. Complete task despite notification failure
      const completedIsolationTask = await completeTask({
        organizationId: primaryOrg._id,
        projectId: primaryProject._id,
        taskId: isolationTask._id,
        completionNote: 'Completed during simulated notification failure',
        actor: { userId: engineerUser._id, displayName: 'Engineer' }
      });

      assert.strictEqual(completedIsolationTask.status, 'COMPLETED', 'Task completed successfully');
      simulatedTaskCompletedSuccess = true;
    } finally {
      // Restore original Notification.create
      Notification.create = originalCreate;
    }

    assert.strictEqual(simulatedTaskCompletedSuccess, true, 'Task completed successfully despite notification error');
    console.log('[PASS] 22. Simulated notification creation failure handled cleanly.');
    console.log('[PASS] 23. Confirmed underlying Task business action succeeds even when notification fails.');

    console.log('\n======================================================');
    console.log('ALL 23 NOTIFICATION BACKEND TESTS PASSED SUCCESSFULLY!');
    console.log('======================================================\n');
  } finally {
    await cleanup();
    server.close();
  }
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n[FATAL TEST ERROR]:', err);
  process.exit(1);
});
