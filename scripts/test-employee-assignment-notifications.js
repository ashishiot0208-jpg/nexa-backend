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
  EmployeeProfile,
  Team,
  TeamMember,
  Alarm,
  AlarmEvent,
  Task,
  TaskEvent,
  TaskUpdate,
  Investigation,
  InvestigationEvent,
  Notification
} from '../src/models/index.js';
import { createAlarm } from '../src/services/alarm.service.js';
import {
  createTask,
  assignTask,
  completeTask
} from '../src/services/task.service.js';
import {
  createInvestigation,
  assignInvestigation,
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
  console.log('=== Starting NexaIQ Phase 2 — Employee Assignment Notifications Verification ===\n');

  await mongoose.connect(env.mongoUri);
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const runTag = `EMP-NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // Track created entities for thorough cleanup
  const createdUserIds = [];
  const createdOrgIds = [];
  const createdProjectIds = [];
  const createdTeamIds = [];
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
      if (createdTeamIds.length) {
        await TeamMember.deleteMany({ teamId: { $in: createdTeamIds } });
        await Team.deleteMany({ _id: { $in: createdTeamIds } });
      }
      if (createdUserIds.length) {
        await User.deleteMany({ _id: { $in: createdUserIds } });
        await OrganizationMember.deleteMany({ userId: { $in: createdUserIds } });
        await ProjectMember.deleteMany({ userId: { $in: createdUserIds } });
        await EmployeeProfile.deleteMany({ userId: { $in: createdUserIds } });
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
    // Setup Primary Organization & Project (ROLE_BASED)
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

    // Foreign Organization & Project for isolation tests
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

    // -------------------------------------------------------------------------
    // Setup Users & Employees
    // -------------------------------------------------------------------------
    // Admin User
    const adminUser = await User.create({
      email: `admin-${runTag.toLowerCase()}@test.com`,
      displayName: 'Project Admin',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(adminUser._id);

    await OrganizationMember.create({
      organizationId: primaryOrg._id,
      userId: adminUser._id,
      organizationRole: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: primaryProject._id,
      userId: adminUser._id,
      role: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });

    // Employee A (Geotechnical Engineer)
    const employeeUserA = await User.create({
      email: `emp-a-${runTag.toLowerCase()}@test.com`,
      displayName: 'Employee A',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(employeeUserA._id);

    await OrganizationMember.create({
      organizationId: primaryOrg._id,
      userId: employeeUserA._id,
      organizationRole: 'ENGINEER',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: primaryProject._id,
      userId: employeeUserA._id,
      role: 'ENGINEER',
      status: 'ACTIVE'
    });
    await EmployeeProfile.create({
      organizationId: primaryOrg._id,
      userId: employeeUserA._id,
      employeeCode: `EMP-A-${Date.now().toString().slice(-5)}`,
      displayName: 'Employee A',
      status: 'ACTIVE'
    });

    // Employee B (Field Operator)
    const employeeUserB = await User.create({
      email: `emp-b-${runTag.toLowerCase()}@test.com`,
      displayName: 'Employee B',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(employeeUserB._id);

    await OrganizationMember.create({
      organizationId: primaryOrg._id,
      userId: employeeUserB._id,
      organizationRole: 'OPERATOR',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: primaryProject._id,
      userId: employeeUserB._id,
      role: 'OPERATOR',
      status: 'ACTIVE'
    });
    await EmployeeProfile.create({
      organizationId: primaryOrg._id,
      userId: employeeUserB._id,
      employeeCode: `EMP-B-${Date.now().toString().slice(-5)}`,
      displayName: 'Employee B',
      status: 'ACTIVE'
    });

    // Team 1 with Employee A and Employee B
    const testTeam = await Team.create({
      organizationId: primaryOrg._id,
      name: `Maintenance Team ${runTag}`,
      teamCode: `TM-${Date.now().toString().slice(-5)}`,
      status: 'ACTIVE'
    });
    createdTeamIds.push(testTeam._id);

    await TeamMember.create({
      organizationId: primaryOrg._id,
      teamId: testTeam._id,
      userId: employeeUserA._id,
      status: 'ACTIVE'
    });
    await TeamMember.create({
      organizationId: primaryOrg._id,
      teamId: testTeam._id,
      userId: employeeUserB._id,
      status: 'ACTIVE'
    });

    // Foreign Employee (in foreignOrg & foreignProject)
    const foreignEmployee = await User.create({
      email: `femp-${runTag.toLowerCase()}@test.com`,
      displayName: 'Foreign Employee',
      passwordHash: 'dummy-hash',
      status: 'ACTIVE'
    });
    createdUserIds.push(foreignEmployee._id);

    await OrganizationMember.create({
      organizationId: foreignOrg._id,
      userId: foreignEmployee._id,
      organizationRole: 'ENGINEER',
      status: 'ACTIVE'
    });
    await ProjectMember.create({
      projectId: foreignProject._id,
      userId: foreignEmployee._id,
      role: 'ENGINEER',
      status: 'ACTIVE'
    });
    await EmployeeProfile.create({
      organizationId: foreignOrg._id,
      userId: foreignEmployee._id,
      employeeCode: `FEMP-${Date.now().toString().slice(-5)}`,
      displayName: 'Foreign Employee',
      status: 'ACTIVE'
    });

    // Tokens
    const adminToken = signToken(adminUser, primaryOrg._id, 'ADMINISTRATOR');
    const tokenEmpA = signToken(employeeUserA, primaryOrg._id, 'ENGINEER');
    const tokenEmpB = signToken(employeeUserB, primaryOrg._id, 'OPERATOR');
    const foreignEmpToken = signToken(foreignEmployee, foreignOrg._id, 'ENGINEER');

    console.log('[SETUP] Test fixture created successfully.');

    // =========================================================================
    // SECTION 1: Task Assignment Notifications
    // =========================================================================
    console.log('\n--- Section 1: Task Assignment Notifications ---');

    // 1 & 2. Initial Task assignment to Employee-A creates one EMPLOYEE_TASK_ASSIGNED
    const task1 = await createTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Inspection Task ${runTag}`,
      description: 'Perform routine sensor check',
      priority: 'HIGH',
      assignedTeamId: testTeam._id,
      assignedUserId: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });
    createdTaskIds.push(task1._id);

    const empANotifsAfterCreate = await Notification.find({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      recipientUserId: employeeUserA._id,
      type: 'EMPLOYEE_TASK_ASSIGNED',
      relatedObjectId: task1._id
    }).lean();

    assert.strictEqual(empANotifsAfterCreate.length, 1, '1. Exactly one EMPLOYEE_TASK_ASSIGNED notification created');
    assert.strictEqual(empANotifsAfterCreate[0].recipientUserId.toString(), employeeUserA._id.toString(), '2. Correct Employee receives it');
    assert.strictEqual(empANotifsAfterCreate[0].title, 'Task assigned to you');
    assert.strictEqual(empANotifsAfterCreate[0].relatedObjectType, 'TASK');
    assert.strictEqual(empANotifsAfterCreate[0].relatedObjectCode, task1.taskCode);
    assert.strictEqual(empANotifsAfterCreate[0].importance, 'NORMAL');
    createdNotificationIds.push(empANotifsAfterCreate[0]._id);
    console.log('[PASS] 1. Initial Task assignment to Employee-A creates one EMPLOYEE_TASK_ASSIGNED.');
    console.log('[PASS] 2. Correct Employee receives it.');

    // 3. Another Employee (Employee-B) does NOT receive it
    const empBNotifsInitial = await Notification.countDocuments({
      recipientUserId: employeeUserB._id,
      relatedObjectId: task1._id
    });
    assert.strictEqual(empBNotifsInitial, 0, '3. Another Employee does not receive initial assignment notification');
    console.log('[PASS] 3. Another Employee does not receive it.');

    // 4. Team-only Task assignment creates NO Employee notification
    const taskTeamOnly = await createTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Team-Only Task ${runTag}`,
      priority: 'LOW',
      assignedTeamId: testTeam._id,
      assignedUserId: null,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });
    createdTaskIds.push(taskTeamOnly._id);

    const teamOnlyNotifsCount = await Notification.countDocuments({
      relatedObjectId: taskTeamOnly._id,
      type: { $in: ['EMPLOYEE_TASK_ASSIGNED', 'EMPLOYEE_TASK_REASSIGNED'] }
    });
    assert.strictEqual(teamOnlyNotifsCount, 0, '4. Team-only task assignment created 0 employee notifications');
    console.log('[PASS] 4. Team-only Task assignment creates no Employee notification.');

    // 5. Saving same Task assignee again creates NO duplicate
    await assignTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      taskId: task1._id,
      assignedTeamId: testTeam._id,
      assignedUserId: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });

    const empANotifsAfterResave = await Notification.countDocuments({
      recipientUserId: employeeUserA._id,
      relatedObjectId: task1._id
    });
    assert.strictEqual(empANotifsAfterResave, 1, '5. Resaving same assignee created 0 duplicate notifications');
    console.log('[PASS] 5. Saving same Task assignee again creates no duplicate.');

    // 6. Reassign Employee-A -> Employee-B creates one EMPLOYEE_TASK_REASSIGNED for B
    await assignTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      taskId: task1._id,
      assignedTeamId: testTeam._id,
      assignedUserId: employeeUserB._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });

    const empBNotifsReassigned = await Notification.find({
      recipientUserId: employeeUserB._id,
      relatedObjectId: task1._id,
      type: 'EMPLOYEE_TASK_REASSIGNED'
    }).lean();
    assert.strictEqual(empBNotifsReassigned.length, 1, '6. Exactly one EMPLOYEE_TASK_REASSIGNED for Employee B');
    assert.strictEqual(empBNotifsReassigned[0].title, 'Task reassigned to you');
    createdNotificationIds.push(empBNotifsReassigned[0]._id);
    console.log('[PASS] 6. Reassign Employee-A → Employee-B creates one EMPLOYEE_TASK_REASSIGNED for B.');

    // 7. Employee-A receives NO new reassignment notification
    const empANotifsAfterReassign = await Notification.countDocuments({
      recipientUserId: employeeUserA._id,
      relatedObjectId: task1._id
    });
    assert.strictEqual(empANotifsAfterReassign, 1, '7. Employee-A count remains 1 (no removal/reassignment notification sent to A)');
    console.log('[PASS] 7. Employee-A receives no new reassignment notification.');

    // 8. Unassigning Employee creates NO notification
    await assignTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      taskId: task1._id,
      assignedTeamId: testTeam._id,
      assignedUserId: null,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });

    const totalNotifsAfterUnassign = await Notification.countDocuments({
      relatedObjectId: task1._id
    });
    assert.strictEqual(totalNotifsAfterUnassign, 2, '8. Total task notifications remain 2 after unassignment');
    console.log('[PASS] 8. Unassigning Employee creates no notification.');

    // 9. Reassigning back to A later creates a legitimate new reassignment notification
    await assignTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      taskId: task1._id,
      assignedTeamId: testTeam._id,
      assignedUserId: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });

    const empANotifsAfterReassignBack = await Notification.find({
      recipientUserId: employeeUserA._id,
      relatedObjectId: task1._id
    }).lean();
    assert.strictEqual(empANotifsAfterReassignBack.length, 2, '9. Employee-A now has 2 notifications (1 initial, 1 new reassignment)');
    const latestA = empANotifsAfterReassignBack.find(n => n.type === 'EMPLOYEE_TASK_REASSIGNED');
    assert(Boolean(latestA), 'Legitimate new reassignment notification created for A');
    createdNotificationIds.push(latestA._id);
    console.log('[PASS] 9. Reassigning back to A later can create a legitimate new reassignment notification.');

    // =========================================================================
    // SECTION 2: Investigation Assignment Notifications
    // =========================================================================
    console.log('\n--- Section 2: Investigation Assignment Notifications ---');

    // 10 & 11. Initial Investigation assignment creates EMPLOYEE_INVESTIGATION_ASSIGNED
    const inv1 = await createInvestigation({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Slope Discontinuity Investigation ${runTag}`,
      priority: 'HIGH',
      assignedTeamId: testTeam._id,
      assignedTo: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });
    createdInvestigationIds.push(inv1._id);

    const empAInvNotifs = await Notification.find({
      recipientUserId: employeeUserA._id,
      relatedObjectId: inv1._id,
      type: 'EMPLOYEE_INVESTIGATION_ASSIGNED'
    }).lean();
    assert.strictEqual(empAInvNotifs.length, 1, '10. Exactly one EMPLOYEE_INVESTIGATION_ASSIGNED created');
    assert.strictEqual(empAInvNotifs[0].title, 'Investigation assigned to you');
    assert.strictEqual(empAInvNotifs[0].relatedObjectType, 'INVESTIGATION');
    assert.strictEqual(empAInvNotifs[0].importance, 'IMPORTANT');
    createdNotificationIds.push(empAInvNotifs[0]._id);
    console.log('[PASS] 10. Initial Investigation assignment creates EMPLOYEE_INVESTIGATION_ASSIGNED.');
    console.log('[PASS] 11. Correct Employee receives it.');

    // 12. Team-only Investigation assignment creates NO Employee notification
    const invTeamOnly = await createInvestigation({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Team-Only Investigation ${runTag}`,
      priority: 'MEDIUM',
      assignedTeamId: testTeam._id,
      assignedTo: null,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });
    createdInvestigationIds.push(invTeamOnly._id);

    const teamOnlyInvCount = await Notification.countDocuments({
      relatedObjectId: invTeamOnly._id,
      type: { $in: ['EMPLOYEE_INVESTIGATION_ASSIGNED', 'EMPLOYEE_INVESTIGATION_REASSIGNED'] }
    });
    assert.strictEqual(teamOnlyInvCount, 0, '12. Team-only investigation created 0 employee notifications');
    console.log('[PASS] 12. Team-only Investigation assignment creates no Employee notification.');

    // 13. Same assignee resave creates NO duplicate
    await assignInvestigation({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      investigationId: inv1._id,
      assignedTeamId: testTeam._id,
      assignedTo: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });

    const empAInvResaveCount = await Notification.countDocuments({
      recipientUserId: employeeUserA._id,
      relatedObjectId: inv1._id
    });
    assert.strictEqual(empAInvResaveCount, 1, '13. Resaving same assignee creates 0 duplicate notifications');
    console.log('[PASS] 13. Same assignee resave creates no duplicate.');

    // 14. Reassign A -> B creates EMPLOYEE_INVESTIGATION_REASSIGNED for B only
    await assignInvestigation({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      investigationId: inv1._id,
      assignedTeamId: testTeam._id,
      assignedTo: employeeUserB._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });

    const empBInvReassigned = await Notification.find({
      recipientUserId: employeeUserB._id,
      relatedObjectId: inv1._id,
      type: 'EMPLOYEE_INVESTIGATION_REASSIGNED'
    }).lean();
    assert.strictEqual(empBInvReassigned.length, 1, '14. Exactly one EMPLOYEE_INVESTIGATION_REASSIGNED for Employee B');
    assert.strictEqual(empBInvReassigned[0].title, 'Investigation reassigned to you');
    createdNotificationIds.push(empBInvReassigned[0]._id);

    const empAInvAfterReassign = await Notification.countDocuments({
      recipientUserId: employeeUserA._id,
      relatedObjectId: inv1._id
    });
    assert.strictEqual(empAInvAfterReassign, 1, 'Employee A received no new notification on reassignment to B');
    console.log('[PASS] 14. Reassign A → B creates EMPLOYEE_INVESTIGATION_REASSIGNED for B only.');

    // 15. Reassigning back later is treated as a new genuine event
    await assignInvestigation({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      investigationId: inv1._id,
      assignedTeamId: testTeam._id,
      assignedTo: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Project Admin' }
    });

    const empAInvBack = await Notification.find({
      recipientUserId: employeeUserA._id,
      relatedObjectId: inv1._id,
      type: 'EMPLOYEE_INVESTIGATION_REASSIGNED'
    }).lean();
    assert.strictEqual(empAInvBack.length, 1, '15. Legitimate new reassignment notification created for A');
    createdNotificationIds.push(empAInvBack[0]._id);
    console.log('[PASS] 15. Reassigning back later is treated as a new genuine event.');

    // =========================================================================
    // SECTION 3: Inbox API
    // =========================================================================
    console.log('\n--- Section 3: Inbox API ---');

    // 16. Employee can list own notifications
    const listRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications`, {
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    });
    assert.strictEqual(listRes.status, 200, '16. Employee can access notifications list');
    const empANotifsList = await listRes.json();
    assert(Array.isArray(empANotifsList), 'Returns array of notifications');
    assert(empANotifsList.length >= 3, 'Employee A sees all notifications addressed to them');
    for (const item of empANotifsList) {
      assert.strictEqual(item.recipientUserId.toString(), employeeUserA._id.toString(), 'Every notification belongs to Employee A');
    }
    console.log('[PASS] 16. Employee can list own notifications.');

    // 17. Employee unread count works
    const countRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    });
    assert.strictEqual(countRes.status, 200, '17. Employee can get unread count');
    const countData = await countRes.json();
    assert(typeof countData.count === 'number', 'count is a number');
    assert(countData.count >= 3, 'All 3 notifications for Employee A are currently UNREAD');
    console.log('[PASS] 17. Employee unread count works.');

    // 18. Employee can mark own notification read
    const targetNotifId = empANotifsList[0]._id;
    const markReadRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/${targetNotifId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    });
    assert.strictEqual(markReadRes.status, 200, '18. Employee can mark notification read');
    const updatedNotif = await markReadRes.json();
    assert.strictEqual(updatedNotif.isRead, true, 'isRead is true');

    const countAfterOneRead = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    }).then(r => r.json());
    assert.strictEqual(countAfterOneRead.count, countData.count - 1, 'Unread count decreased by 1');
    console.log('[PASS] 18. Employee can mark own notification read.');

    // 19. Employee can mark all own notifications read
    const markAllRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/mark-all-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    });
    assert.strictEqual(markAllRes.status, 200, '19. Employee can mark all notifications read');

    const countAfterAllRead = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    }).then(r => r.json());
    assert.strictEqual(countAfterAllRead.count, 0, 'Unread count is now 0');
    console.log('[PASS] 19. Employee can mark all own notifications read.');

    // 20. Employee cannot read another Employee's notification
    const empBNotif = await Notification.findOne({ recipientUserId: employeeUserB._id }).lean();
    assert(Boolean(empBNotif), 'Employee B notification exists');

    const unauthorizedReadRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications/${empBNotif._id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    });
    assert.strictEqual(unauthorizedReadRes.status, 403, '20. Employee A is blocked from marking Employee B notification read');
    console.log('[PASS] 20. Employee cannot read another Employee\'s notification.');

    // 21. Cross-project access blocked
    const crossProjListRes = await fetch(`${baseUrl}/projects/${foreignProject._id}/notifications`, {
      headers: { Authorization: `Bearer ${tokenEmpA}` }
    });
    assert.strictEqual(crossProjListRes.status, 403, '21. Employee blocked from foreign project notifications');
    console.log('[PASS] 21. Cross-project access blocked.');

    // 22. Cross-organization access blocked
    const crossOrgListRes = await fetch(`${baseUrl}/projects/${primaryProject._id}/notifications`, {
      headers: { Authorization: `Bearer ${foreignEmpToken}` }
    });
    assert.strictEqual(crossOrgListRes.status, 403, '22. Foreign org employee blocked from primary project notifications');
    console.log('[PASS] 22. Cross-organization access blocked.');

    // =========================================================================
    // SECTION 4: Existing Admin System Preserved
    // =========================================================================
    console.log('\n--- Section 4: Existing Admin System Preserved ---');

    // 23. Admin S4 notification still works
    const s4Alarm = await createAlarm({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      category: 'ENGINEERING_SEVERITY',
      title: `INC-${runTag} · S4 Alarm Test`,
      parameterCode: 'displacement_x',
      initialSeverity: 'S4',
      reason: 'THRESHOLD_S4_EXCEEDED'
    });
    createdAlarmIds.push(s4Alarm.alarm._id);

    const adminS4Notif = await Notification.findOne({
      recipientUserId: adminUser._id,
      relatedObjectId: s4Alarm.alarm._id,
      type: 'ADMIN_S4_ALARM'
    }).lean();
    assert(Boolean(adminS4Notif), '23. Admin received S4 Alarm notification');
    createdNotificationIds.push(adminS4Notif._id);
    console.log('[PASS] 23. Admin S4 notification still works.');

    // 24. Admin Task Completed notification still works
    const adminObservedTask = await createTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Admin Observed Task ${runTag}`,
      priority: 'MEDIUM',
      assignedTeamId: testTeam._id,
      assignedUserId: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Admin' }
    });
    createdTaskIds.push(adminObservedTask._id);

    adminObservedTask.status = 'IN_PROGRESS';
    await adminObservedTask.save();

    await completeTask({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      taskId: adminObservedTask._id,
      completionNote: 'Completed by Employee A',
      actor: { userId: employeeUserA._id, displayName: 'Employee A' }
    });

    const adminTaskCompletedNotif = await Notification.findOne({
      recipientUserId: adminUser._id,
      relatedObjectId: adminObservedTask._id,
      type: 'ADMIN_TASK_COMPLETED'
    }).lean();
    assert(Boolean(adminTaskCompletedNotif), '24. Admin received Task Completed notification');
    createdNotificationIds.push(adminTaskCompletedNotif._id);
    console.log('[PASS] 24. Admin Task Completed notification still works.');

    // 25. Admin Task Overdue notification still works
    const overduePastTask = await Task.create({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Overdue Task ${runTag}`,
      status: 'OPEN',
      priority: 'HIGH',
      dueDate: new Date(Date.now() - 3600000)
    });
    createdTaskIds.push(overduePastTask._id);

    const overdueScanResult = await checkAndNotifyOverdueTasks({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id
    });
    assert(overdueScanResult.scanned >= 1, 'Scanned overdue task');

    const adminOverdueNotif = await Notification.findOne({
      recipientUserId: adminUser._id,
      relatedObjectId: overduePastTask._id,
      type: 'ADMIN_TASK_OVERDUE'
    }).lean();
    assert(Boolean(adminOverdueNotif), '25. Admin received Task Overdue notification');
    createdNotificationIds.push(adminOverdueNotif._id);
    console.log('[PASS] 25. Admin Task Overdue notification still works.');

    // 26. Admin Investigation Completed notification still works
    const completedInv = await createInvestigation({
      organizationId: primaryOrg._id,
      projectId: primaryProject._id,
      title: `Admin Investigation ${runTag}`,
      priority: 'HIGH',
      assignedTeamId: testTeam._id,
      assignedTo: employeeUserA._id,
      actor: { userId: adminUser._id, displayName: 'Admin' }
    });
    createdInvestigationIds.push(completedInv._id);

    completedInv.status = 'IN_PROGRESS';
    await completedInv.save();

    await completeInvestigation({
      investigationId: completedInv._id,
      projectId: primaryProject._id,
      organizationId: primaryOrg._id,
      conclusion: 'Soil saturation normalized after drainage clear',
      rootCause: 'Surface drainage blockage',
      recommendedAction: 'Install automated pump',
      actor: { userId: employeeUserA._id, displayName: 'Employee A' },
      comment: 'Investigation successfully completed'
    });

    const adminInvCompletedNotif = await Notification.findOne({
      recipientUserId: adminUser._id,
      relatedObjectId: completedInv._id,
      type: 'ADMIN_INVESTIGATION_COMPLETED'
    }).lean();
    assert(Boolean(adminInvCompletedNotif), '26. Admin received Investigation Completed notification');
    createdNotificationIds.push(adminInvCompletedNotif._id);
    console.log('[PASS] 26. Admin Investigation Completed notification still works.');

    // 27. Employee assignment does not incorrectly appear in unrelated Admin inbox
    const adminInboxItems = await Notification.find({
      recipientUserId: adminUser._id,
      type: { $in: ['EMPLOYEE_TASK_ASSIGNED', 'EMPLOYEE_TASK_REASSIGNED', 'EMPLOYEE_INVESTIGATION_ASSIGNED', 'EMPLOYEE_INVESTIGATION_REASSIGNED'] }
    }).lean();
    assert.strictEqual(adminInboxItems.length, 0, '27. Admin personal inbox contains 0 employee assignment notifications');
    console.log('[PASS] 27. Employee assignment does not incorrectly appear in unrelated Admin inbox.');

    // =========================================================================
    // SECTION 5: Failure Isolation
    // =========================================================================
    console.log('\n--- Section 5: Failure Isolation ---');

    // 28. Notification creation failure does not fail Task assignment
    const originalCreate = Notification.create;
    Notification.create = async () => {
      throw new Error('Simulated database failure for employee notification');
    };

    let taskAssignmentSucceeded = false;
    let invAssignmentSucceeded = false;

    try {
      const isolationTask = await createTask({
        organizationId: primaryOrg._id,
        projectId: primaryProject._id,
        title: `Isolation Task ${runTag}`,
        status: 'OPEN',
        priority: 'MEDIUM',
        assignedTeamId: testTeam._id,
        assignedUserId: null,
        actor: { userId: adminUser._id, displayName: 'Admin' }
      });
      createdTaskIds.push(isolationTask._id);

      const assignedIsolationTask = await assignTask({
        organizationId: primaryOrg._id,
        projectId: primaryProject._id,
        taskId: isolationTask._id,
        assignedTeamId: testTeam._id,
        assignedUserId: employeeUserA._id,
        actor: { userId: adminUser._id, displayName: 'Admin' }
      });

      assert.strictEqual(assignedIsolationTask.assignedUserId.toString(), employeeUserA._id.toString(), 'Task assigned successfully despite notification failure');
      taskAssignmentSucceeded = true;
    } finally {
      // Keep originalCreate patched for test 29
    }

    assert(taskAssignmentSucceeded, '28. Task assignment succeeded despite notification creation failure');
    console.log('[PASS] 28. Notification creation failure does not fail Task assignment.');

    // 29. Notification creation failure does not fail Investigation assignment
    try {
      const isolationInv = await createInvestigation({
        organizationId: primaryOrg._id,
        projectId: primaryProject._id,
        title: `Isolation Investigation ${runTag}`,
        priority: 'LOW',
        assignedTeamId: testTeam._id,
        assignedTo: null,
        actor: { userId: adminUser._id, displayName: 'Admin' }
      });
      createdInvestigationIds.push(isolationInv._id);

      const assignedIsolationInv = await assignInvestigation({
        organizationId: primaryOrg._id,
        projectId: primaryProject._id,
        investigationId: isolationInv._id,
        assignedTeamId: testTeam._id,
        assignedTo: employeeUserA._id,
        actor: { userId: adminUser._id, displayName: 'Admin' }
      });

      assert.strictEqual(assignedIsolationInv.assignedTo.toString(), employeeUserA._id.toString(), 'Investigation assigned successfully despite notification failure');
      invAssignmentSucceeded = true;
    } finally {
      // Restore original Notification.create
      Notification.create = originalCreate;
    }

    assert(invAssignmentSucceeded, '29. Investigation assignment succeeded despite notification creation failure');
    console.log('[PASS] 29. Notification creation failure does not fail Investigation assignment.');

    console.log('\n======================================================');
    console.log('ALL 29 EMPLOYEE NOTIFICATION TESTS PASSED SUCCESSFULLY!');
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
