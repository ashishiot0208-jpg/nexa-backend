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
  DerivedReading,
  Investigation,
  EmployeeProfile,
  Team,
  TeamMember,
  ProjectTeamAccess
} from '../src/models/index.js';
import { getUserProjectTeamPermissions } from '../src/services/workforce-permission.service.js';
import { ALL_PERMISSION_KEYS, ACCESS_PROFILES } from '../src/config/permissions.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
const TEST_PORT = 3128;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function assert(condition, message) {
  if (!condition) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(message);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
}

async function runSuite() {
  console.log('========================================================');
  console.log('PHASE A1A — WORKFORCE, TEAMS & ACCESS VERIFICATION SUITE');
  console.log('========================================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  // Snapshot existing records to verify immutability
  const preSnapshot = {
    projectMembers: await ProjectMember.countDocuments(),
    alarms: await Alarm.countDocuments(),
    derivedReadings: await DerivedReading.countDocuments(),
    investigations: await Investigation.countDocuments()
  };

  // Find authoritative project LAN-PRO-01 in ORG-1
  const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
  assert(Boolean(project), `Found project LAN-PRO-01 (_id: ${project._id})`);

  const projectId = String(project._id);
  const org1Id = String(project.organizationId);
  const foreignOrgId = '6ac4c514fb791da169ce9a06'; // Demo Org

  // Clean up any previous test workforce data
  const prevTestTeams = await Team.find({ teamCode: /^TEST-/ }).select('_id').lean();
  await TeamMember.deleteMany({ $or: [{ teamId: { $in: prevTestTeams.map((t) => t._id) } }, { organizationId: { $in: [org1Id, foreignOrgId] } }] });
  await EmployeeProfile.deleteMany({ organizationId: { $in: [org1Id, foreignOrgId] }, employeeCode: /^TEST-/ });
  await Team.deleteMany({ organizationId: { $in: [org1Id, foreignOrgId] }, teamCode: /^TEST-/ });
  await ProjectTeamAccess.deleteMany({ organizationId: { $in: [org1Id, foreignOrgId] }, projectId: project._id });

  // Users in ORG-1
  const adminUser = await User.findOne({ email: 'admin@geonexa.test' }).lean();
  const engineerUser = await User.findOne({ email: 'engineer@geonexa.test' }).lean();
  const operatorUser = await User.findOne({ email: 'differing-role@geonexa.test' }).lean();
  const viewerUser = await User.findOne({ email: 'viewer@geonexa.test' }).lean();

  // User in Foreign Org (not in ORG-1)
  const foreignUser = await User.findOne({ email: 'operator@geonexa.local' }).lean();

  assert(Boolean(adminUser && engineerUser && operatorUser && viewerUser && foreignUser), 'Found all test users');

  // Generate JWTs
  const adminToken = jwt.sign({ organizationId: org1Id, organizationRole: 'ADMINISTRATOR' }, env.jwtSecret, { subject: String(adminUser._id), expiresIn: '2h' });
  const engineerToken = jwt.sign({ organizationId: org1Id, organizationRole: 'ENGINEER' }, env.jwtSecret, { subject: String(engineerUser._id), expiresIn: '2h' });
  const operatorToken = jwt.sign({ organizationId: org1Id, organizationRole: 'OPERATOR' }, env.jwtSecret, { subject: String(operatorUser._id), expiresIn: '2h' });
  const viewerToken = jwt.sign({ organizationId: org1Id, organizationRole: 'VIEWER' }, env.jwtSecret, { subject: String(viewerUser._id), expiresIn: '2h' });
  const foreignAdminToken = jwt.sign({ organizationId: foreignOrgId, organizationRole: 'ADMINISTRATOR' }, env.jwtSecret, { subject: String(foreignUser._id), expiresIn: '2h' });

  const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };
  const engineerHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${engineerToken}` };
  const operatorHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` };
  const viewerHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` };
  const foreignHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${foreignAdminToken}` };

  const app = createApp();
  let server;
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });
  console.log(`Server listening on ${BASE_URL}\n`);

  try {
    // -------------------------------------------------------------------------
    // TEST 1: EmployeeProfile created for existing org user
    // -------------------------------------------------------------------------
    console.log('--- Test 1: EmployeeProfile created for existing org user ---');
    const empRes1 = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/employees`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId: String(engineerUser._id),
        employeeCode: 'TEST-EMP-001',
        designation: 'Senior Geotechnical Engineer',
        department: 'Geotechnical'
      })
    });
    assert(empRes1.status === 201, `POST employees returned 201 (got ${empRes1.status})`);
    const empData1 = await empRes1.json();
    assert(empData1.employeeCode === 'TEST-EMP-001', `Created employeeCode matches TEST-EMP-001`);
    assert(empData1.organizationRole === 'ENGINEER', `Populated organizationRole matches ENGINEER`);

    // -------------------------------------------------------------------------
    // TEST 2: Duplicate organizationId+userId profile rejected
    // -------------------------------------------------------------------------
    console.log('\n--- Test 2: Duplicate organizationId+userId profile rejected ---');
    const empDupRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/employees`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId: String(engineerUser._id),
        employeeCode: 'TEST-EMP-002',
        designation: 'Another Designation'
      })
    });
    assert(empDupRes.status === 409, `Duplicate profile rejected with 409 (got ${empDupRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 3: Employee detail loads organization role
    // -------------------------------------------------------------------------
    console.log('\n--- Test 3: Employee detail loads organization role ---');
    const empDetailRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/employees/${empData1._id}`, {
      headers: adminHeaders
    });
    assert(empDetailRes.status === 200, `GET employee detail returned 200`);
    const empDetail = await empDetailRes.json();
    assert(empDetail.organizationMembership?.role === 'ENGINEER', `Employee detail includes org role ENGINEER`);
    assert(empDetail.profile.employeeCode === 'TEST-EMP-001', `Employee detail includes employeeCode`);

    // Also create profile for Operator user
    const empRes2 = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/employees`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId: String(operatorUser._id),
        employeeCode: 'TEST-EMP-002',
        designation: 'Monitoring Specialist',
        department: 'Control Room'
      })
    });
    assert(empRes2.status === 201, 'Created operator employee profile');

    // -------------------------------------------------------------------------
    // TEST 4: Team created
    // -------------------------------------------------------------------------
    console.log('\n--- Test 4: Team created ---');
    const teamRes1 = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'TEST - Geotechnical Engineering',
        teamCode: 'TEST-TEAM-01',
        description: 'Engineering and slope stability team',
        functionLabel: 'Geotechnical Engineering',
        teamLeadUserId: String(engineerUser._id)
      })
    });
    assert(teamRes1.status === 201, `POST team returned 201 (got ${teamRes1.status})`);
    const team1 = await teamRes1.json();
    assert(team1.teamCode === 'TEST-TEAM-01', `Team code matches TEST-TEAM-01`);
    assert(team1.teamLeadUserId === String(engineerUser._id), `Team lead set to engineer user`);

    // Create Team 2: Monitoring
    const teamRes2 = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'TEST - Monitoring Operations',
        teamCode: 'TEST-TEAM-02',
        description: '24/7 Control Room Surveillance',
        functionLabel: 'Monitoring'
      })
    });
    assert(teamRes2.status === 201, 'Created team 2');
    const team2 = await teamRes2.json();

    // -------------------------------------------------------------------------
    // TEST 5: Duplicate team code rejected
    // -------------------------------------------------------------------------
    console.log('\n--- Test 5: Duplicate team code rejected ---');
    const dupTeamRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Another Team',
        teamCode: 'TEST-TEAM-01'
      })
    });
    assert(dupTeamRes.status === 409, `Duplicate teamCode rejected with 409 (got ${dupTeamRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 6: Team member added
    // -------------------------------------------------------------------------
    console.log('\n--- Test 6: Team member added ---');
    const addMemberRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams/${team1._id}/members`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId: String(operatorUser._id),
        membershipRole: 'MEMBER'
      })
    });
    assert(addMemberRes.status === 201, `Added operatorUser to team 1 returned 201`);

    // -------------------------------------------------------------------------
    // TEST 7: Same user can belong to multiple teams
    // -------------------------------------------------------------------------
    console.log('\n--- Test 7: Same user can belong to multiple teams ---');
    const addMemberRes2 = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams/${team2._id}/members`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId: String(operatorUser._id),
        membershipRole: 'LEAD'
      })
    });
    assert(addMemberRes2.status === 201, `Added operatorUser to team 2 returned 201`);

    const operatorTeamsCount = await TeamMember.countDocuments({
      organizationId: org1Id,
      userId: operatorUser._id,
      status: 'ACTIVE'
    });
    assert(operatorTeamsCount === 2, `operatorUser is active member in 2 teams (got ${operatorTeamsCount})`);

    // Also add engineerUser to team 2 as member
    await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams/${team2._id}/members`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId: String(engineerUser._id),
        membershipRole: 'MEMBER'
      })
    });

    // -------------------------------------------------------------------------
    // TEST 8: Cross-org user cannot be added
    // -------------------------------------------------------------------------
    console.log('\n--- Test 8: Cross-org user cannot be added ---');
    const crossUserRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams/${team1._id}/members`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId: String(foreignUser._id),
        membershipRole: 'MEMBER'
      })
    });
    assert(crossUserRes.status === 400, `Cross-org user addition rejected with 400 (got ${crossUserRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 9: Team lead must belong to correct org
    // -------------------------------------------------------------------------
    console.log('\n--- Test 9: Team lead must belong to correct org ---');
    const invalidLeadRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Invalid Lead Team',
        teamCode: 'TEST-TEAM-INV',
        teamLeadUserId: String(foreignUser._id)
      })
    });
    assert(invalidLeadRes.status === 400, `Team with foreign org lead rejected with 400 (got ${invalidLeadRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 10: ProjectTeamAccess created
    // -------------------------------------------------------------------------
    console.log('\n--- Test 10: ProjectTeamAccess created ---');
    const accessRes1 = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/team-access`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        teamId: String(team1._id),
        accessProfile: 'ENGINEERING'
      })
    });
    assert(accessRes1.status === 201, `POST team-access returned 201 (got ${accessRes1.status})`);
    const access1 = await accessRes1.json();
    assert(access1.accessProfile === 'ENGINEERING', `Access profile is ENGINEERING`);
    assert(access1.permissions.length === ACCESS_PROFILES.ENGINEERING.permissions.length, `Preset permissions populated (${access1.permissions.length} perms)`);

    // -------------------------------------------------------------------------
    // TEST 11: Duplicate Team+Project active access rejected
    // -------------------------------------------------------------------------
    console.log('\n--- Test 11: Duplicate Team+Project active access rejected ---');
    const dupAccessRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/team-access`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        teamId: String(team1._id),
        accessProfile: 'ENGINEERING'
      })
    });
    assert(dupAccessRes.status === 409, `Duplicate active project team access rejected with 409 (got ${dupAccessRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 12: Unknown permission key rejected
    // -------------------------------------------------------------------------
    console.log('\n--- Test 12: Unknown permission key rejected ---');
    const invalidPermRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/team-access`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        teamId: String(team2._id),
        accessProfile: 'CUSTOM',
        permissions: ['overview.view', 'malicious.hackEverything', 'bogus.key']
      })
    });
    assert(invalidPermRes.status === 400, `Unknown permission keys rejected with 400 (got ${invalidPermRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 13: Preset permissions load correctly
    // -------------------------------------------------------------------------
    console.log('\n--- Test 13: Preset permissions load correctly ---');
    const accessRes2 = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/team-access`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        teamId: String(team2._id),
        accessProfile: 'MONITORING_OPERATIONS'
      })
    });
    assert(accessRes2.status === 201, `Assigned team 2 MONITORING_OPERATIONS returned 201`);
    const access2 = await accessRes2.json();
    assert(access2.permissions.includes('alarms.acknowledge'), `Includes alarms.acknowledge`);
    assert(!access2.permissions.includes('commissioning.finalize'), `Does not include commissioning.finalize`);

    // -------------------------------------------------------------------------
    // TEST 14: Custom permissions persist
    // -------------------------------------------------------------------------
    console.log('\n--- Test 14: Custom permissions persist ---');
    const customPerms = ['overview.view', 'map.view', 'instruments.view', 'reports.view'];
    const patchCustomRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/team-access/${team2._id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        accessProfile: 'CUSTOM',
        permissions: customPerms
      })
    });
    assert(patchCustomRes.status === 200, `PATCH custom permissions returned 200`);
    const customUpdated = await patchCustomRes.json();
    assert(customUpdated.accessProfile === 'CUSTOM', `Access profile updated to CUSTOM`);
    assert(JSON.stringify(customUpdated.permissions.sort()) === JSON.stringify(customPerms.sort()), `Custom permissions persisted accurately`);

    // -------------------------------------------------------------------------
    // TEST 15: Effective user permissions merge multiple teams
    // -------------------------------------------------------------------------
    console.log('\n--- Test 15: Effective user permissions merge multiple teams ---');
    // operatorUser belongs to team1 (ENGINEERING) and team2 (CUSTOM: overview, map, instruments, reports)
    const effectiveRes = await getUserProjectTeamPermissions({
      organizationId: org1Id,
      projectId,
      userId: String(operatorUser._id)
    });
    assert(effectiveRes.teams.length === 2, `User resolved with 2 teams (got ${effectiveRes.teams.length})`);
    assert(effectiveRes.permissions.includes('overview.view'), `Has overview.view`);
    assert(effectiveRes.permissions.includes('investigations.complete'), `Has investigations.complete from team 1`);
    assert(effectiveRes.permissions.includes('reports.view'), `Has reports.view from team 2`);

    // -------------------------------------------------------------------------
    // TEST 16: Duplicate permission keys removed
    // -------------------------------------------------------------------------
    console.log('\n--- Test 16: Duplicate permission keys removed ---');
    const permKeys = effectiveRes.permissions;
    const uniqueKeys = Array.from(new Set(permKeys));
    assert(permKeys.length === uniqueKeys.length, `Effective permissions deduplicated (length ${permKeys.length})`);

    // -------------------------------------------------------------------------
    // TEST 17: Inactive Team excluded from active permission resolution
    // -------------------------------------------------------------------------
    console.log('\n--- Test 17: Inactive Team excluded from active permission resolution ---');
    await Team.findByIdAndUpdate(team1._id, { status: 'INACTIVE' });
    const effectiveAfterTeamInactive = await getUserProjectTeamPermissions({
      organizationId: org1Id,
      projectId,
      userId: String(operatorUser._id)
    });
    // Team 1 is inactive, so its permissions (like investigations.complete) must NOT be present
    assert(effectiveAfterTeamInactive.teams.length === 1, `Only active team 2 resolved (got ${effectiveAfterTeamInactive.teams.length})`);
    assert(!effectiveAfterTeamInactive.permissions.includes('investigations.complete'), `Inactive team 1 permissions strictly excluded`);
    // Reactivate team 1
    await Team.findByIdAndUpdate(team1._id, { status: 'ACTIVE' });

    // -------------------------------------------------------------------------
    // TEST 18: Inactive TeamMember excluded
    // -------------------------------------------------------------------------
    console.log('\n--- Test 18: Inactive TeamMember excluded ---');
    await TeamMember.findOneAndUpdate({ teamId: team2._id, userId: operatorUser._id }, { status: 'INACTIVE' });
    const effectiveAfterMemberInactive = await getUserProjectTeamPermissions({
      organizationId: org1Id,
      projectId,
      userId: String(operatorUser._id)
    });
    assert(effectiveAfterMemberInactive.teams.length === 1, `Team 2 excluded when membership is inactive`);
    assert(effectiveAfterMemberInactive.teams[0].teamId.toString() === String(team1._id), `Only team 1 membership active`);
    // Reactivate member
    await TeamMember.findOneAndUpdate({ teamId: team2._id, userId: operatorUser._id }, { status: 'ACTIVE' });

    // -------------------------------------------------------------------------
    // TEST 19: Inactive ProjectTeamAccess excluded
    // -------------------------------------------------------------------------
    console.log('\n--- Test 19: Inactive ProjectTeamAccess excluded ---');
    await ProjectTeamAccess.findOneAndUpdate({ projectId, teamId: team1._id }, { status: 'INACTIVE' });
    const effectiveAfterAccessInactive = await getUserProjectTeamPermissions({
      organizationId: org1Id,
      projectId,
      userId: String(operatorUser._id)
    });
    assert(!effectiveAfterAccessInactive.permissions.includes('investigations.complete'), `Inactive ProjectTeamAccess excluded from resolution`);
    // Reactivate access
    await ProjectTeamAccess.findOneAndUpdate({ projectId, teamId: team1._id }, { status: 'ACTIVE' });

    // -------------------------------------------------------------------------
    // TEST 20: Cross-org ProjectTeamAccess rejected
    // -------------------------------------------------------------------------
    console.log('\n--- Test 20: Cross-org ProjectTeamAccess rejected ---');
    // Create team in Demo Org (Foreign Org)
    const foreignTeam = await Team.create({
      organizationId: foreignOrgId,
      teamCode: 'TEST-FOREIGN-01',
      name: 'Foreign Org Team',
      status: 'ACTIVE'
    });
    // Attempt to assign foreign team to ORG-1's project LAN-PRO-01
    const crossAccessRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/team-access`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        teamId: String(foreignTeam._id),
        accessProfile: 'ENGINEERING'
      })
    });
    assert(crossAccessRes.status === 400 || crossAccessRes.status === 403, `Cross-org team assignment rejected with ${crossAccessRes.status}`);

    // -------------------------------------------------------------------------
    // TEST 21: Viewer cannot mutate Administration data
    // -------------------------------------------------------------------------
    console.log('\n--- Test 21: Viewer cannot mutate Administration data ---');
    const viewerMutateRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: viewerHeaders,
      body: JSON.stringify({ name: 'Unauthorized Team', teamCode: 'TEST-UNAUTH-1' })
    });
    assert(viewerMutateRes.status === 403, `Viewer mutation rejected with 403 (got ${viewerMutateRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 22: Operator cannot mutate Administration data
    // -------------------------------------------------------------------------
    console.log('\n--- Test 22: Operator cannot mutate Administration data ---');
    const operatorMutateRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ name: 'Unauthorized Team 2', teamCode: 'TEST-UNAUTH-2' })
    });
    assert(operatorMutateRes.status === 403, `Operator mutation rejected with 403 (got ${operatorMutateRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 23: Engineer cannot mutate Administration data
    // -------------------------------------------------------------------------
    console.log('\n--- Test 23: Engineer cannot mutate Administration data ---');
    const engineerMutateRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: engineerHeaders,
      body: JSON.stringify({ name: 'Unauthorized Team 3', teamCode: 'TEST-UNAUTH-3' })
    });
    assert(engineerMutateRes.status === 403, `Engineer mutation rejected with 403 (got ${engineerMutateRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 24: Administrator can mutate
    // -------------------------------------------------------------------------
    console.log('\n--- Test 24: Administrator can mutate ---');
    const adminMutateRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Admin Authorized Team', teamCode: 'TEST-AUTH-ADMIN' })
    });
    assert(adminMutateRes.status === 201, `Administrator mutation accepted with 201 (got ${adminMutateRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 25: Existing req.projectRole behavior unchanged
    // -------------------------------------------------------------------------
    console.log('\n--- Test 25: Existing req.projectRole behavior unchanged ---');
    // Call GET /projects/:projectId
    const projDetailRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}`, {
      headers: engineerHeaders
    });
    assert(projDetailRes.status === 200, `GET /projects/:projectId returned 200`);
    const projDetail = await projDetailRes.json();
    assert(Boolean(projDetail.projectRole), `projectRole resolved and present: ${projDetail.projectRole}`);
    assert(Boolean(projDetail.currentUserRole), `currentUserRole resolved and present: ${projDetail.currentUserRole}`);

    // Call GET /projects/:projectId/access
    const accessCheckRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/access`, {
      headers: engineerHeaders
    });
    assert(accessCheckRes.status === 200, `GET /projects/:projectId/access returned 200`);
    const accessCheck = await accessCheckRes.json();
    assert(Boolean(accessCheck.projectRole), `access endpoint returns projectRole: ${accessCheck.projectRole}`);

    // -------------------------------------------------------------------------
    // TEST 26: Existing ProjectMember records unchanged
    // -------------------------------------------------------------------------
    console.log('\n--- Test 26: Existing ProjectMember records unchanged ---');
    const currentProjectMemberCount = await ProjectMember.countDocuments();
    assert(currentProjectMemberCount === preSnapshot.projectMembers, `ProjectMember count unchanged (${currentProjectMemberCount} === ${preSnapshot.projectMembers})`);

    // -------------------------------------------------------------------------
    // TEST 27: Investigation assignment unchanged
    // -------------------------------------------------------------------------
    console.log('\n--- Test 27: Investigation assignment unchanged ---');
    const currentInvestigationCount = await Investigation.countDocuments();
    assert(currentInvestigationCount === preSnapshot.investigations, `Investigation count unchanged (${currentInvestigationCount} === ${preSnapshot.investigations})`);

    // -------------------------------------------------------------------------
    // TEST 28: No existing Alarm/Telemetry/Report records modified
    // -------------------------------------------------------------------------
    console.log('\n--- Test 28: No existing Alarm/Telemetry/Report records modified ---');
    const currentAlarmCount = await Alarm.countDocuments();
    const currentReadingCount = await DerivedReading.countDocuments();
    assert(currentAlarmCount === preSnapshot.alarms, `Alarm count untouched (${currentAlarmCount} === ${preSnapshot.alarms})`);
    assert(currentReadingCount === preSnapshot.derivedReadings, `Telemetry count untouched (${currentReadingCount} === ${preSnapshot.derivedReadings})`);

    // -------------------------------------------------------------------------
    // TEST 29: Organization isolation test passes
    // -------------------------------------------------------------------------
    console.log('\n--- Test 29: Organization isolation test passes ---');
    // Token from Foreign Org attempting to access ORG-1's employees
    const crossOrgEmpRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/employees`, {
      headers: foreignHeaders
    });
    assert(crossOrgEmpRes.status === 403, `Cross-org employee access rejected with 403 (got ${crossOrgEmpRes.status})`);

    // Token from Foreign Org attempting to access ORG-1's teams
    const crossOrgTeamRes = await fetch(`${BASE_URL}/api/v1/organizations/${org1Id}/teams`, {
      headers: foreignHeaders
    });
    assert(crossOrgTeamRes.status === 403, `Cross-org teams access rejected with 403 (got ${crossOrgTeamRes.status})`);

    // Token from Foreign Org attempting to access ORG-1's project team access
    const crossOrgProjAccessRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/team-access`, {
      headers: foreignHeaders
    });
    assert(crossOrgProjAccessRes.status === 403 || crossOrgProjAccessRes.status === 404, `Cross-org project team access rejected with ${crossOrgProjAccessRes.status}`);

    // -------------------------------------------------------------------------
    // TEST 30: Central Permission Catalog & Effective Permissions APIs
    // -------------------------------------------------------------------------
    console.log('\n--- Test 30: Central Permission Catalog API & Effective permissions endpoint ---');
    const catalogRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/access-permissions`, {
      headers: adminHeaders
    });
    assert(catalogRes.status === 200, `Permission catalog API returned 200`);
    const catalogData = await catalogRes.json();
    assert(Array.isArray(catalogData.groups) && catalogData.groups.length > 0, `Catalog has permission groups`);
    assert(Array.isArray(catalogData.permissions) && catalogData.permissions.length === ALL_PERMISSION_KEYS.size, `Catalog has all permissions (${catalogData.permissions.length})`);
    assert(Boolean(catalogData.profiles?.ENGINEERING), `Catalog has ENGINEERING profile`);

    const effectiveApiRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/effective-permissions/${operatorUser._id}`, {
      headers: adminHeaders
    });
    assert(effectiveApiRes.status === 200, `Effective permissions API returned 200`);
    const effectiveApiData = await effectiveApiRes.json();
    assert(effectiveApiData.userId === String(operatorUser._id), `Effective API returns correct userId`);
    assert(Array.isArray(effectiveApiData.permissions), `Effective API returns permissions array`);

    // -------------------------------------------------------------------------
    // TEST 31: Security Regression: ORG-A Team never leaks to ORG-B
    // -------------------------------------------------------------------------
    console.log('\n--- Test 31: Security Regression: ORG-A Team never leaks to ORG-B ---');
    const foreignOrgTeamsRes = await fetch(`${BASE_URL}/api/v1/organizations/${foreignOrgId}/teams`, {
      headers: foreignHeaders
    });
    assert(foreignOrgTeamsRes.status === 200, `Foreign org teams GET returned 200`);
    const foreignOrgTeams = await foreignOrgTeamsRes.json();
    const leakedTeam = foreignOrgTeams.find((t) => t.teamCode.startsWith('TEST-TEAM-'));
    assert(!leakedTeam, 'ORG-1 teams strictly excluded from Foreign Org teams list');

    console.log('\n\x1b[32m========================================================\x1b[0m');
    console.log('\x1b[32mALL 30 VERIFICATION CRITERIA & SECURITY REGRESSION PASSED\x1b[0m');
    console.log('\x1b[32m========================================================\x1b[0m\n');
  } finally {
    // Clean up test data
    const endTestTeams = await Team.find({ teamCode: /^TEST-/ }).select('_id').lean();
    await TeamMember.deleteMany({ $or: [{ teamId: { $in: endTestTeams.map((t) => t._id) } }, { organizationId: { $in: [org1Id, foreignOrgId] } }] });
    await EmployeeProfile.deleteMany({ organizationId: { $in: [org1Id, foreignOrgId] }, employeeCode: /^TEST-/ });
    await Team.deleteMany({ organizationId: { $in: [org1Id, foreignOrgId] }, teamCode: /^TEST-/ });
    await ProjectTeamAccess.deleteMany({ organizationId: { $in: [org1Id, foreignOrgId] }, projectId: project._id });
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
  }
}

runSuite().catch((err) => {
  console.error('\n\x1b[31m[SUITE FAILED]\x1b[0m', err);
  process.exit(1);
});
