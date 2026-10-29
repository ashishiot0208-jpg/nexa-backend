import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  User,
  OrganizationMember,
  ProjectMember,
  Alarm,
  Investigation,
  EngineeringSeverityRule,
  AlarmTriggerPolicy,
  Device,
  EmployeeProfile,
  Team,
  TeamMember,
  ProjectTeamAccess
} from '../src/models/index.js';
import { ALL_PERMISSION_KEYS } from '../src/config/permissions.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
const TEST_PORT = 3131;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function assert(condition, message) {
  if (!condition) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(message);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
}

function makeToken(user, organizationId, organizationRole) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      organizationId: String(organizationId || user.organizationId),
      organizationRole: organizationRole || (user.role === 'admin' ? 'ADMINISTRATOR' : 'MEMBER')
    },
    env.jwtSecret || 'geonexa-secret',
    { expiresIn: '1h' }
  );
}

async function request(urlPath, options = {}) {
  const { method = 'GET', token, body, headers = {} } = options;
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data, headers: res.headers };
}

async function runTestSuite() {
  console.log('========================================================');
  console.log('PHASE A1D — COMPREHENSIVE PERMISSION ENFORCEMENT TEST');
  console.log('========================================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  // Clean up any residual test data before snapshot
  const prevTeamsInit = await Team.find({ teamCode: /^TEST-A1D-/ }).select('_id').lean();
  if (prevTeamsInit.length > 0) {
    const prevTeamIds = prevTeamsInit.map(t => t._id);
    await TeamMember.deleteMany({ teamId: { $in: prevTeamIds } });
    await ProjectTeamAccess.deleteMany({ teamId: { $in: prevTeamIds } });
    await Team.deleteMany({ _id: { $in: prevTeamIds } });
  }
  const prevProjInit = await Project.findOne({ code: 'TEST-A1D-PRO' });
  if (prevProjInit) {
    await ProjectMember.deleteMany({ projectId: prevProjInit._id });
    await ProjectTeamAccess.deleteMany({ projectId: prevProjInit._id });
    await Alarm.deleteMany({ projectId: prevProjInit._id });
    await Investigation.deleteMany({ projectId: prevProjInit._id });
    await EngineeringSeverityRule.deleteMany({ projectId: prevProjInit._id });
    await Project.deleteOne({ _id: prevProjInit._id });
  }
  await User.deleteMany({ email: 'noteam@geonexa.test' });

  // Snapshot existing ProjectMember records
  const initialProjectMemberCount = await ProjectMember.countDocuments();
  console.log(`Initial ProjectMember count across DB: ${initialProjectMemberCount}`);

  // Find authoritative project LAN-PRO-01
  const lanProject = await Project.findOne({ code: 'LAN-PRO-01' });
  assert(Boolean(lanProject), 'Found project LAN-PRO-01');
  const lanProjectId = String(lanProject._id);
  const orgId = String(lanProject.organizationId);
  const initialLanMembers = await ProjectMember.find({ projectId: lanProject._id }).lean();

  // Verify LAN-PRO-01 initial mode is ROLE_BASED
  assert(lanProject.accessMode === 'ROLE_BASED' || !lanProject.accessMode, 'LAN-PRO-01 initial mode is ROLE_BASED');

  // Find or create test users in ORG-1
  let adminUser = await User.findOne({ email: 'admin@geonexa.test' });
  if (!adminUser) {
    adminUser = await User.create({ email: 'admin@geonexa.test', name: 'Admin User', role: 'admin', organizationId: orgId });
  }
  let engineerUser = await User.findOne({ email: 'engineer@geonexa.test' });
  if (!engineerUser) {
    engineerUser = await User.create({ email: 'engineer@geonexa.test', name: 'Engineer User', role: 'member', organizationId: orgId });
  }
  let operatorUser = await User.findOne({ email: 'operator@geonexa.test' });
  if (!operatorUser) {
    operatorUser = await User.create({ email: 'operator@geonexa.test', name: 'Operator User', role: 'member', organizationId: orgId });
  }
  let viewerUser = await User.findOne({ email: 'viewer@geonexa.test' });
  if (!viewerUser) {
    viewerUser = await User.create({ email: 'viewer@geonexa.test', name: 'Viewer User', role: 'member', organizationId: orgId });
  }

  // Ensure OrganizationMember records exist
  await OrganizationMember.findOneAndUpdate(
    { organizationId: orgId, userId: adminUser._id },
    { organizationId: orgId, userId: adminUser._id, organizationRole: 'ADMINISTRATOR', status: 'ACTIVE' },
    { upsert: true }
  );
  await OrganizationMember.findOneAndUpdate(
    { organizationId: orgId, userId: engineerUser._id },
    { organizationId: orgId, userId: engineerUser._id, organizationRole: 'ENGINEER', status: 'ACTIVE' },
    { upsert: true }
  );
  await OrganizationMember.findOneAndUpdate(
    { organizationId: orgId, userId: operatorUser._id },
    { organizationId: orgId, userId: operatorUser._id, organizationRole: 'OPERATOR', status: 'ACTIVE' },
    { upsert: true }
  );
  await OrganizationMember.findOneAndUpdate(
    { organizationId: orgId, userId: viewerUser._id },
    { organizationId: orgId, userId: viewerUser._id, organizationRole: 'VIEWER', status: 'ACTIVE' },
    { upsert: true }
  );

  // Tokens
  const adminToken = makeToken(adminUser, orgId, 'ADMINISTRATOR');
  const engineerToken = makeToken(engineerUser, orgId, 'ENGINEER');
  const operatorToken = makeToken(operatorUser, orgId, 'OPERATOR');
  const viewerToken = makeToken(viewerUser, orgId, 'VIEWER');

  // Setup express test server
  const app = createApp();
  const server = app.listen(TEST_PORT);
  console.log(`Test server running on port ${TEST_PORT}\n`);

  try {
    // =========================================================================
    // SECTION A: ROLE_BASED MODE TESTS (LAN-PRO-01)
    // =========================================================================
    console.log('--- SECTION A: ROLE_BASED MODE ON LAN-PRO-01 ---');

    // Test 1: Existing Engineer behavior unchanged
    const engOverviewRes = await request(`/api/v1/projects/${lanProjectId}/overview`, { token: engineerToken });
    assert(engOverviewRes.status === 200, 'Test 1.1: Engineer can view overview in ROLE_BASED mode');

    const engAlarmsRes = await request(`/api/v1/projects/${lanProjectId}/alarms`, { token: engineerToken });
    assert(engAlarmsRes.status === 200, 'Test 1.2: Engineer can view alarms in ROLE_BASED mode');

    // Test 2: Existing Operator behavior unchanged
    const opAlarmsRes = await request(`/api/v1/projects/${lanProjectId}/alarms`, { token: operatorToken });
    assert(opAlarmsRes.status === 200, 'Test 2.1: Operator can view alarms in ROLE_BASED mode');

    // Test 3: Existing Viewer behavior unchanged
    const viewAlarmsRes = await request(`/api/v1/projects/${lanProjectId}/alarms`, { token: viewerToken });
    assert(viewAlarmsRes.status === 200, 'Test 3.1: Viewer can view alarms in ROLE_BASED mode');

    // Test 4: Administrator behavior unchanged
    const adminOverviewRes = await request(`/api/v1/projects/${lanProjectId}/overview`, { token: adminToken });
    assert(adminOverviewRes.status === 200, 'Test 4.1: Administrator has full access in ROLE_BASED mode');

    // Readiness check on LAN-PRO-01
    const readinessRes = await request(`/api/v1/projects/${lanProjectId}/access-mode/readiness`, { token: adminToken });
    assert(readinessRes.status === 200, 'Readiness check endpoint works on LAN-PRO-01');
    assert(readinessRes.data.isReady === false, `LAN-PRO-01 readiness reports isReady: false (uncovered members: ${readinessRes.data.uncoveredMembers})`);
    console.log(`Uncovered members count in LAN-PRO-01: ${readinessRes.data.uncoveredMembers}`);

    // Verify blocking activation on LAN-PRO-01
    const blockSwitchRes = await request(`/api/v1/projects/${lanProjectId}/access-mode`, {
      method: 'PATCH',
      token: adminToken,
      body: { accessMode: 'TEAM_PERMISSIONS' }
    });
    assert(blockSwitchRes.status === 400, 'Switching LAN-PRO-01 to TEAM_PERMISSIONS is blocked due to uncovered members');

    // =========================================================================
    // SECTION B: CONTROLLED TEAM_PERMISSIONS MODE SUITE (Dedicated Test Project)
    // =========================================================================
    console.log('\n--- SECTION B: TEAM_PERMISSIONS MODE VALIDATION ---');

    // Clean up any previous test project, teams, and members
    const prevTeams = await Team.find({ teamCode: /^TEST-A1D-/ }).select('_id').lean();
    if (prevTeams.length > 0) {
      const prevTeamIds = prevTeams.map(t => t._id);
      await TeamMember.deleteMany({ teamId: { $in: prevTeamIds } });
      await ProjectTeamAccess.deleteMany({ teamId: { $in: prevTeamIds } });
      await Team.deleteMany({ _id: { $in: prevTeamIds } });
    }
    const prevProj = await Project.findOne({ code: 'TEST-A1D-PRO' });
    if (prevProj) {
      await ProjectMember.deleteMany({ projectId: prevProj._id });
      await ProjectTeamAccess.deleteMany({ projectId: prevProj._id });
      await Project.deleteOne({ _id: prevProj._id });
    }
    const noTeamUsers = await User.find({ email: 'noteam@geonexa.test' }).select('_id');
    if (noTeamUsers.length > 0) {
      await OrganizationMember.deleteMany({ userId: { $in: noTeamUsers.map(u => u._id) } });
      await User.deleteMany({ _id: { $in: noTeamUsers.map(u => u._id) } });
    }
    const testProject = await Project.create({
      organizationId: orgId,
      name: 'Test A1D Enforcement Project',
      code: 'TEST-A1D-PRO',
      status: 'ACTIVE',
      accessMode: 'ROLE_BASED'
    });
    const testProjectId = String(testProject._id);

    // Add members to test project
    await ProjectMember.deleteMany({ projectId: testProject._id });
    await ProjectMember.create([
      { organizationId: orgId, projectId: testProject._id, userId: adminUser._id, role: 'ADMINISTRATOR' },
      { organizationId: orgId, projectId: testProject._id, userId: engineerUser._id, role: 'ENGINEER' },
      { organizationId: orgId, projectId: testProject._id, userId: operatorUser._id, role: 'OPERATOR' },
      { organizationId: orgId, projectId: testProject._id, userId: viewerUser._id, role: 'VIEWER' }
    ]);

    // Create an Alarm in test project for testing acknowledge and resolve
    await Alarm.deleteMany({ projectId: testProject._id });
    const testAlarm = await Alarm.create({
      organizationId: orgId,
      projectId: testProject._id,
      title: 'High Pressure Alarm',
      severity: 'S3',
      status: 'OPEN',
      category: 'ENGINEERING_SEVERITY',
      currentSeverity: 'S3',
      triggeredAt: new Date()
    });

    // Create an Investigation in test project
    await Investigation.deleteMany({ projectId: testProject._id });
    const testInv = await Investigation.create({
      organizationId: orgId,
      projectId: testProject._id,
      title: 'Investigation into High Pressure',
      status: 'OPEN',
      alarmId: testAlarm._id
    });

    // Create an EngineeringSeverityRule in test project
    await EngineeringSeverityRule.deleteMany({ projectId: testProject._id });
    const testSevRule = await EngineeringSeverityRule.create({
      organizationId: orgId,
      projectId: testProject._id,
      code: 'RULE-TEST-001',
      name: 'Pressure Critical Limit',
      parameterCode: 'WATER_PRESSURE',
      metric: 'engineeringValue',
      mode: 'INCREASING',
      unit: 'kPa',
      thresholds: { s1: 50, s2: 75, s3: 100 },
      status: 'ACTIVE'
    });

    // Create Teams
    // Team A: Alarms & Investigations & Reports View
    const teamA = await Team.create({
      organizationId: orgId,
      teamCode: 'TEST-A1D-TMA',
      name: 'Operations Alpha',
      status: 'ACTIVE'
    });

    // Team B: Resolver & Admin & Export & Severity Rules
    const teamB = await Team.create({
      organizationId: orgId,
      teamCode: 'TEST-A1D-TMB',
      name: 'Resolution Team',
      status: 'ACTIVE'
    });

    // Assign engineer, operator, viewer to Team A
    await TeamMember.create([
      { organizationId: orgId, teamId: teamA._id, userId: engineerUser._id, membershipRole: 'MEMBER', status: 'ACTIVE' },
      { organizationId: orgId, teamId: teamA._id, userId: operatorUser._id, membershipRole: 'MEMBER', status: 'ACTIVE' },
      { organizationId: orgId, teamId: teamA._id, userId: viewerUser._id, membershipRole: 'MEMBER', status: 'ACTIVE' }
    ]);

    // Assign ProjectTeamAccess for Team A
    await ProjectTeamAccess.create({
      organizationId: orgId,
      projectId: testProject._id,
      teamId: teamA._id,
      accessProfile: 'CUSTOM',
      permissions: ['alarms.view', 'alarms.acknowledge', 'investigations.view', 'investigations.start', 'investigations.addFinding', 'reports.view'],
      status: 'ACTIVE'
    });

    // Now test project readiness:
    const testReadiness = await request(`/api/v1/projects/${testProjectId}/access-mode/readiness`, { token: adminToken });
    assert(testReadiness.data.isReady === true, 'Test project is ready for TEAM_PERMISSIONS activation');

    // Switch test project to TEAM_PERMISSIONS
    const enableRes = await request(`/api/v1/projects/${testProjectId}/access-mode`, {
      method: 'PATCH',
      token: adminToken,
      body: { accessMode: 'TEAM_PERMISSIONS' }
    });
    if (enableRes.status !== 200) {
      console.log('ENABLE RES ERROR:', JSON.stringify(enableRes.data));
    }
    assert(enableRes.status === 200, 'Enabled TEAM_PERMISSIONS mode on test project');
    assert(enableRes.data.accessMode === 'TEAM_PERMISSIONS', 'Test project accessMode is now TEAM_PERMISSIONS');

    // Test 5: Engineer with alarms.view can view Alarms
    const engAlarmViewRes = await request(`/api/v1/projects/${testProjectId}/alarms`, { token: engineerToken });
    assert(engAlarmViewRes.status === 200, 'Test 5: Engineer with alarms.view can view Alarms');

    // Test 6: Create user with NO teams/permissions attempting alarm view
    const noTeamUser = await User.create({
      email: 'noteam@geonexa.test',
      displayName: 'No Team User',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuu',
      status: 'ACTIVE'
    });
    await OrganizationMember.create({ organizationId: orgId, userId: noTeamUser._id, organizationRole: 'ENGINEER', status: 'ACTIVE' });
    await ProjectMember.create({ organizationId: orgId, projectId: testProject._id, userId: noTeamUser._id, role: 'ENGINEER' });
    const noTeamToken = makeToken(noTeamUser, orgId, 'ENGINEER');

    const noTeamAlarmRes = await request(`/api/v1/projects/${testProjectId}/alarms`, { token: noTeamToken });
    assert(noTeamAlarmRes.status === 403, 'Test 6: User without alarms.view receives 403 on alarms endpoint');

    // Test 7: alarms.acknowledge works only with permission
    // Engineer has alarms.acknowledge via Team A
    const engAckRes = await request(`/api/v1/projects/${testProjectId}/alarms/${testAlarm._id}/acknowledge`, {
      method: 'POST',
      token: engineerToken,
      body: { comment: 'Acknowledged by engineer' }
    });
    assert(engAckRes.status === 200, 'Test 7.1: alarms.acknowledge succeeds with permission');

    // No-team user receives 403 on acknowledge
    const noTeamAckRes = await request(`/api/v1/projects/${testProjectId}/alarms/${testAlarm._id}/acknowledge`, {
      method: 'POST',
      token: noTeamToken,
      body: { comment: 'Unauthorized ack attempt' }
    });
    assert(noTeamAckRes.status === 403, 'Test 7.2: alarms.acknowledge without permission returns 403');

    // Test 8: alarms.resolve works only with permission
    // Engineer only has Team A (no alarms.resolve)
    const engResolveRes = await request(`/api/v1/projects/${testProjectId}/alarms/${testAlarm._id}/resolve`, {
      method: 'POST',
      token: engineerToken,
      body: { resolutionReason: 'Attempted resolution without permission' }
    });
    assert(engResolveRes.status === 403, 'Test 8.1: alarms.resolve returns 403 when user lacks alarms.resolve');

    // Assign engineer to Team B and grant ProjectTeamAccess to Team B
    await TeamMember.create({ organizationId: orgId, teamId: teamB._id, userId: engineerUser._id, membershipRole: 'MEMBER', status: 'ACTIVE' });
    await ProjectTeamAccess.create({
      organizationId: orgId,
      projectId: testProject._id,
      teamId: teamB._id,
      accessProfile: 'CUSTOM',
      permissions: ['alarms.resolve', 'investigations.complete', 'reports.export', 'severityRules.configure', 'severityRules.activate'],
      status: 'ACTIVE'
    });

    const engResolveRes2 = await request(`/api/v1/projects/${testProjectId}/alarms/${testAlarm._id}/resolve`, {
      method: 'POST',
      token: engineerToken,
      body: { resolutionReason: 'Resolved with permission' }
    });
    assert(engResolveRes2.status === 200, 'Test 8.2: alarms.resolve succeeds when user gains alarms.resolve');

    // Test 9: Investigation finding requires investigations.addFinding
    const addFindingRes = await request(`/api/v1/projects/${testProjectId}/investigations/${testInv._id}/findings`, {
      method: 'POST',
      token: engineerToken,
      body: { text: 'Water level sensor calibrated properly', type: 'FINDING' }
    });
    assert(addFindingRes.status === 200 || addFindingRes.status === 201, 'Test 9: investigations.addFinding succeeds with permission');

    // Start investigation to transition OPEN -> IN_PROGRESS
    const startInvRes = await request(`/api/v1/projects/${testProjectId}/investigations/${testInv._id}/start`, {
      method: 'POST',
      token: engineerToken,
      body: { comment: 'Starting investigation' }
    });
    assert(startInvRes.status === 200, 'Test 9.5: investigations.start succeeds with permission');

    // Test 10: Investigation complete requires investigations.complete
    // User without complete permission gets 403 (operator is only in Team A, which lacks investigations.complete)
    const opInvCompleteRes = await request(`/api/v1/projects/${testProjectId}/investigations/${testInv._id}/complete`, {
      method: 'POST',
      token: operatorToken,
      body: { conclusion: 'Investigation completed', rootCause: 'Pressure spike' }
    });
    assert(opInvCompleteRes.status === 403, 'Test 10.1: investigations.complete returns 403 when user lacks investigations.complete');

    // Engineer has complete permission (via Team B)
    const engInvCompleteRes = await request(`/api/v1/projects/${testProjectId}/investigations/${testInv._id}/complete`, {
      method: 'POST',
      token: engineerToken,
      body: { conclusion: 'Investigation completed', rootCause: 'Pressure spike' }
    });
    assert(engInvCompleteRes.status === 200, 'Test 10.2: investigations.complete succeeds with permission');

    // Test 11: Report preview requires reports.view
    const reportPreviewRes = await request(`/api/v1/projects/${testProjectId}/reports/monitoring-summary`, { token: engineerToken });
    assert(reportPreviewRes.status === 200, 'Test 11.1: reports.view passes permission check (status 200)');
    const noTeamReportRes = await request(`/api/v1/projects/${testProjectId}/reports/monitoring-summary`, { token: noTeamToken });
    assert(noTeamReportRes.status === 403, 'Test 11.2: reports.view returns 403 without permission');

    // Test 12: Report export additionally requires reports.export
    const opExportRes = await request(`/api/v1/projects/${testProjectId}/reports/monitoring-summary/csv`, { token: operatorToken });
    assert(opExportRes.status === 403, 'Test 12.1: reports.export returns 403 when user lacks reports.export');

    // Test 13: Severity Rule configure requires severityRules.configure
    const opSevConfigRes = await request(`/api/v1/projects/${testProjectId}/severity-rules`, {
      method: 'POST',
      token: operatorToken,
      body: { name: 'Rule 2', parameterCode: 'WATER_PRESSURE', metric: 'engineeringValue', mode: 'INCREASING', unit: 'kPa', thresholds: { s1: 10, s2: 20 } }
    });
    assert(opSevConfigRes.status === 403, 'Test 13.1: severityRules.configure returns 403 when user lacks permission');

    const engSevConfigRes = await request(`/api/v1/projects/${testProjectId}/severity-rules`, {
      method: 'POST',
      token: engineerToken,
      body: { name: 'Rule 2', code: 'RULE-TEST-002', parameterCode: 'WATER_PRESSURE_2', metric: 'engineeringValue', mode: 'INCREASING', unit: 'kPa', thresholds: { s1: 10, s2: 20 } }
    });
    assert(engSevConfigRes.status === 201 || engSevConfigRes.status === 200, 'Test 13.2: severityRules.configure succeeds with permission');

    // Test 14: Severity Rule activation requires severityRules.activate
    const opSevActRes = await request(`/api/v1/projects/${testProjectId}/severity-rules/${testSevRule._id}/status`, {
      method: 'PATCH',
      token: operatorToken,
      body: { status: 'INACTIVE' }
    });
    assert(opSevActRes.status === 403, 'Test 14.1: severityRules.activate returns 403 without permission');

    const engSevActRes = await request(`/api/v1/projects/${testProjectId}/severity-rules/${testSevRule._id}/status`, {
      method: 'PATCH',
      token: engineerToken,
      body: { status: 'INACTIVE' }
    });
    assert(engSevActRes.status === 200, 'Test 14.2: severityRules.activate succeeds with permission');

    // Test 15: Commissioning mutations mapped correctly
    const opCommRegRes = await request(`/api/v1/projects/${testProjectId}/commissioning/devices/bulk-register`, {
      method: 'POST',
      token: operatorToken,
      body: { items: [] }
    });
    assert(opCommRegRes.status === 403, 'Test 15: commissioning.register returns 403 when user lacks commissioning.register');

    // Test 16: Device management mapped correctly
    const opDevManageRes = await request(`/api/v1/projects/${testProjectId}/devices`, {
      method: 'POST',
      token: operatorToken,
      body: { name: 'New Sensor Device' }
    });
    assert(opDevManageRes.status === 403, 'Test 16: devices.manage returns 403 when user lacks devices.manage');

    // Test 17: User in multiple Teams gets union of permissions
    // Engineer is in Team A ('alarms.view', 'alarms.acknowledge', etc.) and Team B ('alarms.resolve', etc.)
    const effectiveRes = await request(`/api/v1/projects/${testProjectId}/effective-permissions`, { token: engineerToken });
    assert(effectiveRes.status === 200, 'Effective permissions resolved successfully');
    const perms = effectiveRes.data.permissions;
    assert(perms.includes('alarms.view') && perms.includes('alarms.resolve') && perms.includes('investigations.complete'), 'Test 17: User in multiple teams gets union of permissions');

    // Test 18: Inactive Team permissions excluded
    await Team.updateOne({ _id: teamB._id }, { isActive: false, status: 'INACTIVE' });
    const effectiveResAfterDeactTeam = await request(`/api/v1/projects/${testProjectId}/effective-permissions`, { token: engineerToken });
    assert(!effectiveResAfterDeactTeam.data.permissions.includes('alarms.resolve'), 'Test 18: Inactive Team permissions are excluded');
    await Team.updateOne({ _id: teamB._id }, { isActive: true, status: 'ACTIVE' });

    // Test 19: Inactive TeamMember permissions excluded
    await TeamMember.updateOne({ teamId: teamB._id, userId: engineerUser._id }, { isActive: false, status: 'INACTIVE' });
    const effectiveResAfterDeactMember = await request(`/api/v1/projects/${testProjectId}/effective-permissions`, { token: engineerToken });
    assert(!effectiveResAfterDeactMember.data.permissions.includes('alarms.resolve'), 'Test 19: Inactive TeamMember permissions are excluded');
    await TeamMember.updateOne({ teamId: teamB._id, userId: engineerUser._id }, { isActive: true, status: 'ACTIVE' });

    // Test 20: Inactive ProjectTeamAccess excluded
    await ProjectTeamAccess.updateOne({ projectId: testProject._id, teamId: teamB._id }, { isActive: false, status: 'INACTIVE' });
    const effectiveResAfterDeactAccess = await request(`/api/v1/projects/${testProjectId}/effective-permissions`, { token: engineerToken });
    assert(!effectiveResAfterDeactAccess.data.permissions.includes('alarms.resolve'), 'Test 20: Inactive ProjectTeamAccess permissions are excluded');
    await ProjectTeamAccess.updateOne({ projectId: testProject._id, teamId: teamB._id }, { isActive: true, status: 'ACTIVE' });

    // Test 21: Administrator has full override (even without team membership)
    // Admin is not in Team A or Team B, but has full override
    const adminAlarm = await Alarm.create({
      organizationId: orgId,
      projectId: testProject._id,
      title: 'Admin Override Test Alarm',
      severity: 'S2',
      status: 'OPEN',
      category: 'ENGINEERING_SEVERITY',
      currentSeverity: 'S2',
      triggeredAt: new Date()
    });
    const adminAckRes = await request(`/api/v1/projects/${testProjectId}/alarms/${adminAlarm._id}/acknowledge`, {
      method: 'POST',
      token: adminToken,
      body: { comment: 'Admin override ack' }
    });
    assert(adminAckRes.status === 200, 'Test 21.1: Administrator has full operational override on alarms.acknowledge');

    const adminSevRes = await request(`/api/v1/projects/${testProjectId}/severity-rules/${testSevRule._id}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'ACTIVE' }
    });
    assert(adminSevRes.status === 200, 'Test 21.2: Administrator has full operational override on severityRules.activate');

    // Test 22: Viewer cannot bypass backend using direct API call
    const viewerAlarm = await Alarm.create({
      organizationId: orgId,
      projectId: testProject._id,
      title: 'Viewer Bypass Attempt Alarm',
      severity: 'S2',
      status: 'OPEN',
      category: 'ENGINEERING_SEVERITY',
      currentSeverity: 'S2',
      triggeredAt: new Date()
    });
    const viewerDirectMutateRes = await request(`/api/v1/projects/${testProjectId}/alarms/${viewerAlarm._id}/acknowledge`, {
      method: 'POST',
      token: viewerToken,
      body: { comment: 'Direct API bypass attempt' }
    });
    assert(viewerDirectMutateRes.status === 403, 'Test 22: Viewer cannot bypass backend using direct API call (403)');

    // Test 23: Hidden frontend module cannot be accessed directly (backend returns 403)
    const viewerTrendsRes = await request(`/api/v1/projects/${testProjectId}/trends`, { token: viewerToken });
    assert(viewerTrendsRes.status === 403, 'Test 23: Hidden module endpoint returns 403 without view permission');

    // Test 24: Cross-org permissions never resolve
    const foreignOrgId = '6ac4c514fb791da169ce9a06';
    const crossOrgToken = makeToken(engineerUser, foreignOrgId);
    const crossOrgRes = await request(`/api/v1/projects/${testProjectId}/alarms`, { token: crossOrgToken });
    assert(crossOrgRes.status === 403 || crossOrgRes.status === 404, 'Test 24: Cross-org token receives 403/404 on project resources');

    // Test 25: Switching back to ROLE_BASED restores previous behavior
    const revertRes = await request(`/api/v1/projects/${testProjectId}/access-mode`, {
      method: 'PATCH',
      token: adminToken,
      body: { accessMode: 'ROLE_BASED' }
    });
    assert(revertRes.status === 200, 'Test 25.1: Successfully reverted to ROLE_BASED');
    assert(revertRes.data.accessMode === 'ROLE_BASED', 'Test 25.2: Project mode is back to ROLE_BASED');

    // In ROLE_BASED mode, engineer can now view trends (as an engineer project-member)
    const engTrendsRoleBasedRes = await request(`/api/v1/projects/${testProjectId}/trends?parameter=PRESSURE`, { token: engineerToken });
    assert(engTrendsRoleBasedRes.status === 200, 'Test 25.3: Switching back to ROLE_BASED restores legacy role access');

    // Cleanup test data
    await Project.deleteOne({ _id: testProject._id });
    await ProjectMember.deleteMany({ projectId: testProject._id });
    await Alarm.deleteMany({ projectId: testProject._id });
    await Investigation.deleteMany({ projectId: testProject._id });
    await EngineeringSeverityRule.deleteMany({ projectId: testProject._id });
    await Team.deleteMany({ _id: { $in: [teamA._id, teamB._id] } });
    await TeamMember.deleteMany({ teamId: { $in: [teamA._id, teamB._id] } });
    await ProjectTeamAccess.deleteMany({ projectId: testProject._id });
    await User.deleteOne({ _id: noTeamUser._id });
    await OrganizationMember.deleteMany({ userId: noTeamUser._id });

    // Verify LAN-PRO-01 remains ROLE_BASED
    const finalLanProject = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(finalLanProject.accessMode === 'ROLE_BASED', 'FINAL CHECK: LAN-PRO-01 remains in ROLE_BASED mode');

    // Verify ProjectMember records were not mutated
    const finalProjectMemberCount = await ProjectMember.countDocuments();
    assert(finalProjectMemberCount === initialProjectMemberCount, `FINAL CHECK: ProjectMember count unchanged (${finalProjectMemberCount} === ${initialProjectMemberCount})`);

    const finalLanMembers = await ProjectMember.find({ projectId: lanProject._id }).lean();
    assert(finalLanMembers.length === initialLanMembers.length, `FINAL CHECK: LAN-PRO-01 member count unchanged (${finalLanMembers.length} === ${initialLanMembers.length})`);
    for (const initM of initialLanMembers) {
      const finM = finalLanMembers.find(m => String(m.userId) === String(initM.userId));
      assert(Boolean(finM) && finM.role === initM.role, `FINAL CHECK: LAN-PRO-01 member ${initM.userId} role unchanged (${initM.role})`);
    }

    console.log('\n========================================================');
    console.log('ALL 25 TESTS IN TEST MATRIX PASSED PERFECTLY!');
    console.log('========================================================\n');
  } finally {
    server.close();
    await mongoose.disconnect();
  }
}

runTestSuite().catch((err) => {
  console.error('\x1b[31mSuite failed with error:\x1b[0m', err);
  process.exit(1);
});
