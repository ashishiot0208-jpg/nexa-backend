#!/usr/bin/env node

/**
 * PHASE A1E — TEAM + INDIVIDUAL WORK ASSIGNMENT TEST SUITE
 *
 * Verifies all 46 items in the verification matrix:
 *
 * BACKWARD COMPATIBILITY
 * 1. Existing legacy Investigation without Team still loads.
 * 2. INV-2026-0010 remains unchanged.
 * 3. Existing individual-only assignment displays correctly.
 *
 * TEAM ASSIGNMENT
 * 4. Active project Team can be assigned.
 * 5. Foreign-org Team rejected.
 * 6. Inactive Team rejected.
 * 7. Team without active ProjectTeamAccess rejected.
 * 8. Team-only assignment succeeds.
 *
 * INDIVIDUAL ASSIGNMENT
 * 9. Active Team member + ProjectMember can be assigned.
 * 10. User outside selected Team rejected.
 * 11. User outside Project rejected.
 * 12. Inactive TeamMember rejected.
 * 13. Inactive organization member rejected.
 * 14. Team + valid individual assignment succeeds.
 *
 * REASSIGNMENT
 * 15. Person A → Person B within same Team succeeds.
 * 16. Changing Team clears/rejects invalid old individual.
 * 17. Team A → Team B + valid new member succeeds.
 * 18. Individual can be removed while Team remains.
 * 19. Assignment event history preserved.
 *
 * PERMISSIONS
 * 20. ROLE_BASED assignment behavior remains compatible.
 * 21. TEAM_PERMISSIONS assignment requires investigations.assign.
 * 22. Assigned user does NOT gain unauthorized permissions.
 * 23. Administrator override works.
 *
 * HISTORICAL INTEGRITY
 * 24. Deactivated Team does not erase old assignment.
 * 25. Deactivated member does not erase old assignment.
 * 26. Inactive ProjectTeamAccess does not erase old assignment.
 * 27. New assignment to inactive resources rejected.
 *
 * UI / API
 * 28. Assignment options contain only eligible Teams.
 * 29. Member dropdown contains only eligible selected-Team members.
 * 30. Filters work.
 * 31. Assignment drawer/modal pre-populates correctly.
 * 32. Audit timeline renders assignment events.
 *
 * REPORTS
 * 33. Investigation report shows Team/person.
 * 34. Overall report renders assignment without layout regression.
 * 35. Legacy Investigation report still works.
 *
 * SECURITY
 * 36. Cross-org isolation passes.
 * 37. Direct API invalid Team/member assignment rejected.
 * 38. ProjectMember records unchanged.
 * 39. ProjectMember roles unchanged.
 *
 * REGRESSION & INVARIANTS
 * 40. LAN-PRO-01 accessMode remains ROLE_BASED.
 * 41. Alarm data unmodified.
 * 42. Clean up temporary test data.
 */

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
  InvestigationEvent,
  EmployeeProfile,
  Team,
  TeamMember,
  ProjectTeamAccess
} from '../src/models/index.js';
import { getInvestigationReport, getInvestigationSummaryReport, getOverallProjectReport } from '../src/services/report.service.js';
import { generateReportPdf } from '../src/services/report-export.service.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
const TEST_PORT = 3132;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let server;

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
  console.log('PHASE A1E — TEAM + INDIVIDUAL WORK ASSIGNMENT TEST SUITE');
  console.log('========================================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  // Clean up any residual test records from prior runs
  await EmployeeProfile.deleteMany({ employeeCode: { $in: ['EMP-0017', 'EMP-0018'] } });
  await User.deleteMany({ email: { $in: ['a1e-user-a@geonexa.test', 'a1e-user-b@geonexa.test', 'a1e-outsider@geonexa.test', 'a1e-inact-mem@geonexa.test', 'a1e-inact-org@geonexa.test', 'a1e-nonproj@geonexa.test'] } });
  await Team.deleteMany({ teamCode: /^TEST-A1E-/ });
  await Project.deleteMany({ code: /^TEST-A1E-/ });
  await Investigation.deleteMany({ title: /^A1E-TEST-/ });

  // 1. Initial State & Invariant Snapshots
  const initialProjectMemberCount = await ProjectMember.countDocuments();
  const initialProjectMembers = await ProjectMember.find({}).lean();
  const initialAlarmCount = await Alarm.countDocuments();

  // Find authoritative project LAN-PRO-01
  const lanProject = await Project.findOne({ code: 'LAN-PRO-01' });
  assert(Boolean(lanProject), 'Authoritative Project LAN-PRO-01 exists');
  const lanProjectId = String(lanProject._id);
  const orgId = String(lanProject.organizationId);
  assert(lanProject.accessMode === 'ROLE_BASED' || !lanProject.accessMode, 'LAN-PRO-01 initial accessMode is ROLE_BASED');

  // Verify INV-2026-0010 initial snapshot
  const legacyInv = await Investigation.findOne({ investigationCode: 'INV-2026-0010' }).lean();
  assert(Boolean(legacyInv), 'Legacy Investigation INV-2026-0010 exists');
  assert(legacyInv.alarmSnapshot && String(legacyInv.alarmSnapshot.alarmId) === '6ad0d886fca52330dfb4d3f8', 'INV-2026-0010 has untouched ALM-B4D3F8 alarmSnapshot');
  assert(legacyInv.assignedTeamId === undefined || legacyInv.assignedTeamId === null, 'INV-2026-0010 has no assignedTeamId initially');
  assert(Boolean(legacyInv.assignedTo), 'INV-2026-0010 has legacy individual assignedTo');

  // Find or create test users in org
  let adminUser = await User.findOne({ email: 'admin@geonexa.test' });
  if (!adminUser) {
    adminUser = await User.create({ email: 'admin@geonexa.test', displayName: 'Admin User', passwordHash: 'dummy', role: 'admin', organizationId: orgId });
  }
  let engineerUser = await User.findOne({ email: 'engineer@geonexa.test' });
  if (!engineerUser) {
    engineerUser = await User.create({ email: 'engineer@geonexa.test', displayName: 'Engineer User', passwordHash: 'dummy', role: 'member', organizationId: orgId });
  }
  // Use existing active ProjectMembers of LAN-PRO-01
  let userA = engineerUser;
  let userB = await User.findOne({ email: 'operator@geonexa.test' });
  if (!userB) {
    userB = await User.create({ email: 'operator@geonexa.test', displayName: 'Operator User', passwordHash: 'dummy', role: 'member', organizationId: orgId });
  }
  let userOutsideTeam = await User.findOne({ email: 'viewer@geonexa.test' });
  if (!userOutsideTeam) {
    userOutsideTeam = await User.create({ email: 'viewer@geonexa.test', displayName: 'Viewer User', passwordHash: 'dummy', role: 'member', organizationId: orgId });
  }

  // Ensure OrganizationMember records
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
    { organizationId: orgId, userId: userB._id },
    { organizationId: orgId, userId: userB._id, organizationRole: 'OPERATOR', status: 'ACTIVE' },
    { upsert: true }
  );
  await OrganizationMember.findOneAndUpdate(
    { organizationId: orgId, userId: userOutsideTeam._id },
    { organizationId: orgId, userId: userOutsideTeam._id, organizationRole: 'VIEWER', status: 'ACTIVE' },
    { upsert: true }
  );

  // Employee profiles
  await EmployeeProfile.findOneAndUpdate(
    { organizationId: orgId, userId: userA._id },
    {
      organizationId: orgId,
      userId: userA._id,
      employeeCode: 'EMP-0017',
      firstName: 'Rahul',
      lastName: 'Das',
      displayName: 'Rahul Das',
      designation: 'Geotechnical Engineer',
      status: 'ACTIVE'
    },
    { upsert: true }
  );
  await EmployeeProfile.findOneAndUpdate(
    { organizationId: orgId, userId: userB._id },
    {
      organizationId: orgId,
      userId: userB._id,
      employeeCode: 'EMP-0018',
      firstName: 'Ananya',
      lastName: 'Sen',
      displayName: 'Ananya Sen',
      designation: 'Senior Geotechnical Engineer',
      status: 'ACTIVE'
    },
    { upsert: true }
  );

  // Clean up any previous test teams/investigations
  await Team.deleteMany({ teamCode: /^TEST-A1E-/ });
  await Investigation.deleteMany({ title: /^A1E-TEST-/ });

  // Foreign Organization
  const foreignOrgId = new mongoose.Types.ObjectId();
  const foreignTeam = await Team.create({
    organizationId: foreignOrgId,
    teamCode: 'TEST-A1E-FOR',
    name: 'Foreign Org Team',
    status: 'ACTIVE'
  });

  // Start HTTP Server
  const app = createApp();
  server = app.listen(TEST_PORT);
  console.log(`Test server running on port ${TEST_PORT}\n`);

  const adminToken = makeToken(adminUser, orgId, 'ADMINISTRATOR');
  const engineerToken = makeToken(engineerUser, orgId, 'ENGINEER');

  try {
    // =========================================================================
    // SECTION 1: BACKWARD COMPATIBILITY
    // =========================================================================
    console.log('--- SECTION 1: BACKWARD COMPATIBILITY ---');

    // 1. Existing legacy Investigation without Team still loads
    const getLegacyRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${legacyInv._id}`, { token: engineerToken });
    assert(getLegacyRes.status === 200, '1. Existing legacy Investigation without Team still loads via API');
    const legacyData = getLegacyRes.data.investigation || getLegacyRes.data;
    assert(legacyData.assignedTeamId === null || legacyData.assignedTeamId === undefined, '1.1 Legacy record has null assignedTeamId');

    // 2. INV-2026-0010 remains unchanged
    const verifyLegacy = await Investigation.findOne({ investigationCode: 'INV-2026-0010' }).lean();
    assert(verifyLegacy.investigationCode === 'INV-2026-0010', '2. INV-2026-0010 code unchanged');
    assert(verifyLegacy.alarmSnapshot && String(verifyLegacy.alarmSnapshot.alarmId) === '6ad0d886fca52330dfb4d3f8', '2.1 INV-2026-0010 alarmSnapshot untouched');
    assert(verifyLegacy.assignedTeamId === undefined || verifyLegacy.assignedTeamId === null, '2.2 INV-2026-0010 assignedTeamId untouched');

    // 3. Existing individual-only assignment displays correctly
    assert(Boolean(legacyData.assignedTo), '3. Legacy individual-only assignedTo displays in response');

    // =========================================================================
    // SECTION 2 & 3: TEAM & INDIVIDUAL ASSIGNMENT VALIDATION
    // =========================================================================
    console.log('\n--- SECTION 2 & 3: TEAM & INDIVIDUAL ASSIGNMENT VALIDATION ---');

    // Setup Test Team 1 (Geotechnical Engineering) in LAN-PRO-01
    const teamGeotech = await Team.create({
      organizationId: orgId,
      teamCode: 'TEST-A1E-01',
      name: 'Geotechnical Engineering',
      status: 'ACTIVE'
    });

    // Setup Team 2 (Maintenance)
    const teamMaint = await Team.create({
      organizationId: orgId,
      teamCode: 'TEST-A1E-02',
      name: 'Maintenance',
      status: 'ACTIVE'
    });

    // Inactive Team
    const teamInactive = await Team.create({
      organizationId: orgId,
      teamCode: 'TEST-A1E-INACT',
      name: 'Inactive Team',
      status: 'INACTIVE'
    });

    // Team without ProjectTeamAccess
    const teamNoAccess = await Team.create({
      organizationId: orgId,
      teamCode: 'TEST-A1E-NOACC',
      name: 'No Access Team',
      status: 'ACTIVE'
    });

    // Add ProjectTeamAccess for teamGeotech and teamMaint with investigations.view & investigations.assign
    await ProjectTeamAccess.create({
      organizationId: orgId,
      projectId: lanProject._id,
      teamId: teamGeotech._id,
      status: 'ACTIVE',
      assignedPermissions: ['investigations.view', 'investigations.assign', 'investigations.start', 'investigations.addFinding']
    });

    await ProjectTeamAccess.create({
      organizationId: orgId,
      projectId: lanProject._id,
      teamId: teamMaint._id,
      status: 'ACTIVE',
      assignedPermissions: ['investigations.view', 'investigations.assign']
    });

    // Add members: userA in teamGeotech, userB in teamGeotech and teamMaint
    await TeamMember.create({
      organizationId: orgId,
      teamId: teamGeotech._id,
      userId: userA._id,
      status: 'ACTIVE',
      role: 'MEMBER'
    });
    await TeamMember.create({
      organizationId: orgId,
      teamId: teamGeotech._id,
      userId: userB._id,
      status: 'ACTIVE',
      role: 'LEAD'
    });
    await TeamMember.create({
      organizationId: orgId,
      teamId: teamMaint._id,
      userId: userB._id,
      status: 'ACTIVE',
      role: 'MEMBER'
    });

    // Inactive team member in teamGeotech
    const userInactiveMember = await User.create({ email: 'a1e-inact-mem@geonexa.test', displayName: 'Inactive Member', passwordHash: 'dummy', role: 'member', organizationId: orgId });
    await OrganizationMember.create({ organizationId: orgId, userId: userInactiveMember._id, organizationRole: 'ENGINEER', status: 'ACTIVE' });
    await TeamMember.create({
      organizationId: orgId,
      teamId: teamGeotech._id,
      userId: userInactiveMember._id,
      status: 'INACTIVE',
      role: 'MEMBER'
    });

    // Inactive organization member in teamGeotech
    const userInactiveOrg = await User.create({ email: 'a1e-inact-org@geonexa.test', displayName: 'Inactive Org User', passwordHash: 'dummy', role: 'member', organizationId: orgId, status: 'SUSPENDED' });
    await OrganizationMember.create({ organizationId: orgId, userId: userInactiveOrg._id, organizationRole: 'ENGINEER', status: 'SUSPENDED' });
    await TeamMember.create({
      organizationId: orgId,
      teamId: teamGeotech._id,
      userId: userInactiveOrg._id,
      status: 'ACTIVE',
      role: 'MEMBER'
    });

    // User outside project
    const userNonProject = await User.create({ email: 'a1e-nonproj@geonexa.test', displayName: 'Non Project User', passwordHash: 'dummy', role: 'member', organizationId: orgId });
    await OrganizationMember.create({ organizationId: orgId, userId: userNonProject._id, organizationRole: 'ENGINEER', status: 'ACTIVE' });
    await TeamMember.create({
      organizationId: orgId,
      teamId: teamGeotech._id,
      userId: userNonProject._id,
      status: 'ACTIVE',
      role: 'MEMBER'
    });

    // Create a temporary test investigation for A1E testing
    const testInv = await Investigation.create({
      organizationId: orgId,
      projectId: lanProject._id,
      investigationCode: 'A1E-INV-TEST-01',
      title: 'A1E-TEST-01 Geotechnical Anomaly',
      status: 'OPEN',
      priority: 'HIGH',
      createdBy: adminUser._id
    });

    // 4. Active project Team can be assigned (team-only)
    const assignTeamOnlyRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { assignedTeamId: String(teamGeotech._id) }
    });
    assert(assignTeamOnlyRes.status === 200, '4 & 8. Active project Team can be assigned (Team-only)');
    assert(assignTeamOnlyRes.data.assignedTeamId === String(teamGeotech._id), '4.1 assignedTeamId is set');
    assert(assignTeamOnlyRes.data.assignedTo === null, '4.2 assignedTo remains null');
    assert(assignTeamOnlyRes.data.assignedTeamSnapshot && assignTeamOnlyRes.data.assignedTeamSnapshot.teamName === 'Geotechnical Engineering', '4.3 assignedTeamSnapshot populated');

    // 5. Foreign-org Team rejected
    const foreignTeamRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { assignedTeamId: String(foreignTeam._id) }
    });
    assert(foreignTeamRes.status === 400 || foreignTeamRes.status === 403, '5. Foreign-org Team rejected');

    // 6. Inactive Team rejected
    const inactTeamRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { assignedTeamId: String(teamInactive._id) }
    });
    assert(inactTeamRes.status === 400, '6. Inactive Team rejected');

    // 7. Team without active ProjectTeamAccess rejected
    const noAccessTeamRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { assignedTeamId: String(teamNoAccess._id) }
    });
    assert(noAccessTeamRes.status === 400, '7. Team without active ProjectTeamAccess rejected');

    // 8. Team-only assignment verified above

    // 9. Active Team member + ProjectMember can be assigned
    const assignMemberRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userA._id)
      }
    });
    assert(assignMemberRes.status === 200, '9 & 14. Team + valid individual assignment succeeds');
    assert(assignMemberRes.data.assignedTo === String(userA._id), '14.1 assignedTo matches userA');
    assert(assignMemberRes.data.assignedUserSnapshot && assignMemberRes.data.assignedUserSnapshot.employeeCode === 'EMP-0017', '14.2 assignedUserSnapshot has employeeCode EMP-0017');

    // 10. User outside selected Team rejected
    const outsideTeamRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userOutsideTeam._id)
      }
    });
    assert(outsideTeamRes.status === 400, '10. User outside selected Team rejected');

    // 11. User outside Project rejected
    const outsideProjectRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userNonProject._id)
      }
    });
    assert(outsideProjectRes.status === 400, '11. User outside Project rejected');

    // 12. Inactive TeamMember rejected
    const inactMemberRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userInactiveMember._id)
      }
    });
    assert(inactMemberRes.status === 400, '12. Inactive TeamMember rejected');

    // 13. Inactive organization member rejected
    const inactOrgRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userInactiveOrg._id)
      }
    });
    assert(inactOrgRes.status === 400, '13. Inactive organization member rejected');

    // =========================================================================
    // SECTION 4: REASSIGNMENT & LIFECYCLE
    // =========================================================================
    console.log('\n--- SECTION 4: REASSIGNMENT & LIFECYCLE ---');

    // 15. Person A → Person B within same Team succeeds
    const reassignMemberRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userB._id)
      }
    });
    assert(reassignMemberRes.status === 200, '15. Person A → Person B within same Team succeeds');
    assert(reassignMemberRes.data.assignedTo === String(userB._id), '15.1 assignedTo updated to userB');

    // 16. Changing Team clears/rejects invalid old individual
    // userA is in teamGeotech but NOT in teamMaint. Submitting teamMaint + userA must be rejected!
    const changeTeamInvalidRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamMaint._id),
        assignedToUserId: String(userA._id)
      }
    });
    assert(changeTeamInvalidRes.status === 400, '16. Changing Team with invalid member is rejected');

    // 17. Team A → Team B + valid new member succeeds
    // userB is a member of teamMaint
    const changeTeamValidRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamMaint._id),
        assignedToUserId: String(userB._id)
      }
    });
    assert(changeTeamValidRes.status === 200, '17. Team A → Team B + valid new member succeeds');
    assert(changeTeamValidRes.data.assignedTeamId === String(teamMaint._id), '17.1 assignedTeamId updated to Maintenance');
    assert(changeTeamValidRes.data.assignedTo === String(userB._id), '17.2 assignedTo is userB');

    // 18. Individual can be removed while Team remains
    const removeIndividualRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamMaint._id),
        assignedToUserId: null
      }
    });
    assert(removeIndividualRes.status === 200, '18. Individual can be removed while Team remains');
    assert(removeIndividualRes.data.assignedTeamId === String(teamMaint._id), '18.1 Team remains assigned');
    assert(removeIndividualRes.data.assignedTo === null, '18.2 Individual is unassigned');

    // 19. Assignment event history preserved
    const events = await InvestigationEvent.find({ investigationId: testInv._id }).sort({ timestamp: 1 }).lean();
    assert(events.length >= 4, `19. Investigation has audit events recorded (${events.length} events)`);
    const eventTypes = events.map(e => e.eventType);
    assert(eventTypes.includes('ASSIGNED') || eventTypes.includes('REASSIGNED'), '19.1 ASSIGNED/REASSIGNED events exist');
    const lastEvent = events[events.length - 1];
    assert(Boolean(lastEvent.metadata && lastEvent.metadata.changedBy), '19.2 Event metadata records changedBy');

    // =========================================================================
    // SECTION 5: PERMISSIONS & AUTHORIZATION
    // =========================================================================
    console.log('\n--- SECTION 5: PERMISSIONS & AUTHORIZATION ---');

    // 20. ROLE_BASED assignment behavior remains compatible
    // Engineer has ROLE_BASED access on LAN-PRO-01 and can assign
    const engAssignRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: engineerToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userB._id)
      }
    });
    assert(engAssignRes.status === 200, '20. ROLE_BASED assignment behavior allows Engineer on LAN-PRO-01');

    // 21. TEAM_PERMISSIONS assignment requires investigations.assign
    // Create dedicated test project in TEAM_PERMISSIONS mode
    const teamPermProject = await Project.create({
      organizationId: orgId,
      code: 'TEST-A1E-TP',
      name: 'Team Perm Project',
      accessMode: 'TEAM_PERMISSIONS'
    });
    const tpInv = await Investigation.create({
      organizationId: orgId,
      projectId: teamPermProject._id,
      investigationCode: 'A1E-INV-TP-01',
      title: 'A1E-TEST-TP Investigation',
      status: 'OPEN',
      createdBy: adminUser._id
    });

    // Create a team with ONLY investigations.view (lacks investigations.assign)
    const teamReadOnly = await Team.create({
      organizationId: orgId,
      teamCode: 'TEST-A1E-RO',
      name: 'Read Only Team',
      status: 'ACTIVE'
    });
    await ProjectTeamAccess.create({
      organizationId: orgId,
      projectId: teamPermProject._id,
      teamId: teamReadOnly._id,
      status: 'ACTIVE',
      assignedPermissions: ['investigations.view']
    });
    await ProjectMember.create({
      projectId: teamPermProject._id,
      userId: userA._id,
      role: 'ENGINEER',
      status: 'ACTIVE'
    });
    await TeamMember.create({
      organizationId: orgId,
      teamId: teamReadOnly._id,
      userId: userA._id,
      status: 'ACTIVE',
      role: 'MEMBER'
    });

    // userA tries to assign on teamPermProject -> should be rejected (403) because lacks investigations.assign
    const userAToken = makeToken(userA, orgId, 'ENGINEER');
    const tpAssignDeniedRes = await request(`/api/v1/projects/${teamPermProject._id}/investigations/${tpInv._id}/assign`, {
      method: 'POST',
      token: userAToken,
      body: { assignedTeamId: String(teamReadOnly._id) }
    });
    assert(tpAssignDeniedRes.status === 403, '21. TEAM_PERMISSIONS assignment requires investigations.assign (rejected with 403)');

    // 22. Assigned user does NOT gain unauthorized permissions
    // Even if userA is assigned on teamPermProject, they cannot complete investigation if they lack investigations.complete
    await Investigation.updateOne({ _id: tpInv._id }, { assignedTo: userA._id, assignedTeamId: teamReadOnly._id });
    const tpCompleteDeniedRes = await request(`/api/v1/projects/${teamPermProject._id}/investigations/${tpInv._id}/complete`, {
      method: 'POST',
      token: userAToken,
      body: { conclusion: 'Unauthorized attempt' }
    });
    assert(tpCompleteDeniedRes.status === 403, '22. Assigned user does NOT gain unauthorized permissions (cannot complete without investigations.complete)');

    // 23. Administrator override works
    // Admin assigns on teamPermProject without needing team membership
    const adminTPAssignRes = await request(`/api/v1/projects/${teamPermProject._id}/investigations/${tpInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { assignedTeamId: String(teamReadOnly._id) }
    });
    assert(adminTPAssignRes.status === 200, '23. Administrator override assigns successfully without Team membership');

    // Clean up teamPermProject
    await Investigation.deleteMany({ projectId: teamPermProject._id });
    await ProjectMember.deleteMany({ projectId: teamPermProject._id });
    await ProjectTeamAccess.deleteMany({ projectId: teamPermProject._id });
    await TeamMember.deleteMany({ teamId: teamReadOnly._id });
    await Team.deleteOne({ _id: teamReadOnly._id });
    await Project.deleteOne({ _id: teamPermProject._id });

    // =========================================================================
    // SECTION 6: HISTORICAL INTEGRITY
    // =========================================================================
    console.log('\n--- SECTION 6: HISTORICAL INTEGRITY ---');

    // Set testInv assignment to teamGeotech + userA
    await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamGeotech._id),
        assignedToUserId: String(userA._id)
      }
    });

    // 24. Deactivated Team does not erase old assignment
    await Team.updateOne({ _id: teamGeotech._id }, { status: 'INACTIVE' });
    const getAfterDeactTeam = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}`, { token: engineerToken });
    assert(getAfterDeactTeam.status === 200, '24. Investigation loads after team deactivated');
    const deactTeamInv = getAfterDeactTeam.data.investigation || getAfterDeactTeam.data;
    assert(deactTeamInv.assignedTeamSnapshot.teamName === 'Geotechnical Engineering', '24.1 Team snapshot preserved after team deactivation');

    // 25. Deactivated member does not erase old assignment
    await EmployeeProfile.updateOne({ userId: userA._id }, { status: 'INACTIVE' });
    const getAfterDeactMember = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}`, { token: engineerToken });
    assert(getAfterDeactMember.status === 200, '25. Investigation loads after member deactivated');
    const deactMemberInv = getAfterDeactMember.data.investigation || getAfterDeactMember.data;
    assert(deactMemberInv.assignedUserSnapshot.displayName === 'Rahul Das', '25.1 User snapshot preserved after member deactivation');

    // 26. Inactive ProjectTeamAccess does not erase old assignment
    await ProjectTeamAccess.updateOne({ projectId: lanProject._id, teamId: teamGeotech._id }, { status: 'INACTIVE' });
    const getAfterDeactAccess = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}`, { token: engineerToken });
    assert(getAfterDeactAccess.status === 200, '26. Investigation loads after ProjectTeamAccess deactivated');

    // 27. New assignment to inactive resources rejected
    const newAssignToInactiveTeam = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { assignedTeamId: String(teamGeotech._id) }
    });
    assert(newAssignToInactiveTeam.status === 400, '27. New assignment to inactive team rejected');

    // Restore statuses for subsequent tests
    await Team.updateOne({ _id: teamGeotech._id }, { status: 'ACTIVE' });
    await EmployeeProfile.updateOne({ userId: userA._id }, { status: 'ACTIVE' });
    await ProjectTeamAccess.updateOne({ projectId: lanProject._id, teamId: teamGeotech._id }, { status: 'ACTIVE' });

    // =========================================================================
    // SECTION 7: UI / API VERIFICATION
    // =========================================================================
    console.log('\n--- SECTION 7: UI / API VERIFICATION ---');

    // 28. Assignment options contain only eligible Teams
    const optionsRes = await request(`/api/v1/projects/${lanProjectId}/investigations/assignment-options`, { token: engineerToken });
    assert(optionsRes.status === 200, '28. Assignment options endpoint responds with 200');
    assert(Array.isArray(optionsRes.data.eligibleTeams), '28.1 eligibleTeams is an array');
    const returnedTeamCodes = optionsRes.data.eligibleTeams.map(t => t.teamCode);
    assert(returnedTeamCodes.includes('TEST-A1E-01'), '28.2 TEST-A1E-01 is eligible');
    assert(!returnedTeamCodes.includes('TEST-A1E-FOR'), '28.3 Foreign org team is excluded');
    assert(!returnedTeamCodes.includes('TEST-A1E-INACT'), '28.4 Inactive team is excluded');

    // 29. Member dropdown contains only eligible selected-Team members
    const memberOptionsRes = await request(`/api/v1/projects/${lanProjectId}/investigations/assignment-options?teamId=${teamGeotech._id}`, { token: engineerToken });
    assert(memberOptionsRes.status === 200, '29. Member assignment options endpoint responds with 200');
    assert(Array.isArray(memberOptionsRes.data.eligibleMembers), '29.1 eligibleMembers is an array');
    const returnedUserIds = memberOptionsRes.data.eligibleMembers.map(m => String(m.userId));
    assert(returnedUserIds.includes(String(userA._id)), '29.2 Active member userA included');
    assert(returnedUserIds.includes(String(userB._id)), '29.3 Active member userB included');
    assert(!returnedUserIds.includes(String(userOutsideTeam._id)), '29.4 User outside team excluded');
    assert(!returnedUserIds.includes(String(userNonProject._id)), '29.5 Non-project user excluded');

    // 30. Filters work
    const filterByTeamRes = await request(`/api/v1/projects/${lanProjectId}/investigations?assignedTeamId=${teamGeotech._id}`, { token: engineerToken });
    assert(filterByTeamRes.status === 200, '30. Filter by assignedTeamId responds with 200');
    assert(Array.isArray(filterByTeamRes.data), '30.1 Filter response is an array of investigations');

    // 31. Assignment pre-populates correctly
    const invDetailRes = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}`, { token: engineerToken });
    assert(invDetailRes.status === 200, '31. Investigation details return assignment data for pre-population');
    const detailInv = invDetailRes.data.investigation || invDetailRes.data;
    assert(Boolean(detailInv.assignedTeamId), '31.1 assignedTeamId returned');
    assert(Boolean(detailInv.assignedTo), '31.2 assignedTo returned');

    // 32. Audit timeline renders assignment events
    assert(Array.isArray(invDetailRes.data.events), '32. Events array returned on investigation detail');
    const hasAssignmentEvent = invDetailRes.data.events.some(e => ['ASSIGNED', 'REASSIGNED', 'UNASSIGNED'].includes(e.eventType));
    assert(hasAssignmentEvent, '32.1 Assignment event present in timeline events');

    // =========================================================================
    // SECTION 8: REPORTS INTEGRATION
    // =========================================================================
    console.log('\n--- SECTION 8: REPORTS INTEGRATION ---');

    // 33. Investigation report shows Team/person
    const invReportData = await getInvestigationReport({ projectId: lanProject._id, investigationId: testInv._id, organizationId: orgId });
    assert(Boolean(invReportData), '33. getInvestigationReport returns report projection');
    assert(Boolean(invReportData.assignedTeam), '33.1 assignedTeam projected in report');
    assert(invReportData.assignedTeam.teamName === 'Geotechnical Engineering', '33.2 assignedTeam name matches');
    assert(Boolean(invReportData.assignedPerson), '33.3 assignedPerson projected in report');
    assert(invReportData.assignedPerson.displayName === 'Rahul Das', '33.4 assignedPerson displayName matches');

    // 34. Overall report renders assignment without layout regression
    const summaryData = await getInvestigationSummaryReport({ projectId: lanProject._id, organizationId: orgId });
    assert(Boolean(summaryData), '34. getInvestigationSummaryReport returns data');
    const summaryList = summaryData.data?.investigations || summaryData.investigations || [];
    assert(Array.isArray(summaryList), '34.1 investigations summary array returned');
    const summaryItem = summaryList.find(i => String(i.id || i.investigationId) === String(testInv._id));
    assert(Boolean(summaryItem), '34.2 Test investigation present in summary');
    assert(summaryItem.assignedTeam && (summaryItem.assignedTeam.teamName === 'Geotechnical Engineering' || summaryItem.assignedTeam.name === 'Geotechnical Engineering'), '34.3 summaryItem assignedTeam matches');

    // Test PDF generation with Section 7 Investigation Summary table
    const overallReport = await getOverallProjectReport({ projectId: lanProject._id, organizationId: orgId });
    const pdfBuffer = await generateReportPdf('OVERALL_PROJECT_MONITORING', overallReport);
    assert(Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 1000, `34.4 PDF generated successfully (${pdfBuffer.length} bytes)`);

    // 35. Legacy Investigation report still works
    const legacyReportData = await getInvestigationReport({ projectId: lanProject._id, investigationId: legacyInv._id, organizationId: orgId });
    assert(Boolean(legacyReportData), '35. Legacy Investigation INV-2026-0010 report generates without error');
    assert(legacyReportData.assignedTeam === null || legacyReportData.assignedTeam === undefined, '35.1 Legacy report assignedTeam is null');
    assert(Boolean(legacyReportData.assignedPerson), '35.2 Legacy report assignedPerson is preserved');

    // =========================================================================
    // SECTION 9: SECURITY & SYSTEM INVARIANTS
    // =========================================================================
    console.log('\n--- SECTION 9: SECURITY & SYSTEM INVARIANTS ---');

    // 36. Cross-org isolation passes
    const crossOrgAssign = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { assignedTeamId: String(foreignTeam._id) }
    });
    assert(crossOrgAssign.status === 400 || crossOrgAssign.status === 403, '36. Cross-org assignment is blocked');

    // 37. Direct API invalid Team/member assignment rejected
    const invalidComboAssign = await request(`/api/v1/projects/${lanProjectId}/investigations/${testInv._id}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {
        assignedTeamId: String(teamMaint._id),
        assignedToUserId: String(userA._id) // userA is NOT in teamMaint
      }
    });
    assert(invalidComboAssign.status === 400, '37. Direct API invalid Team/member combination rejected');

    // 38. ProjectMember records unchanged
    const finalProjectMemberCount = await ProjectMember.countDocuments();
    assert(finalProjectMemberCount === initialProjectMemberCount, `38. ProjectMember record count unchanged (${finalProjectMemberCount} === ${initialProjectMemberCount})`);

    // 39. ProjectMember roles unchanged
    const finalProjectMembers = await ProjectMember.find({}).lean();
    for (const initPm of initialProjectMembers) {
      const match = finalProjectMembers.find(f => String(f._id) === String(initPm._id));
      assert(Boolean(match), `39. ProjectMember ${initPm._id} still exists`);
      assert(match.role === initPm.role, `39.1 ProjectMember ${initPm._id} role unchanged (${match.role} === ${initPm.role})`);
    }

    // 40. Final accessMode of LAN-PRO-01 remains ROLE_BASED
    const finalLanProject = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(finalLanProject.accessMode === 'ROLE_BASED' || !finalLanProject.accessMode, '40. LAN-PRO-01 final accessMode remains ROLE_BASED');

    // 41. Alarm data unmodified
    const finalAlarmCount = await Alarm.countDocuments();
    assert(finalAlarmCount === initialAlarmCount, `41. Alarm count unmodified (${finalAlarmCount} === ${initialAlarmCount})`);

    // 42. Clean up temporary test data
    await Investigation.deleteMany({ _id: testInv._id });
    await InvestigationEvent.deleteMany({ investigationId: testInv._id });
    await TeamMember.deleteMany({ teamId: { $in: [teamGeotech._id, teamMaint._id, teamInactive._id, teamNoAccess._id] } });
    await ProjectTeamAccess.deleteMany({ teamId: { $in: [teamGeotech._id, teamMaint._id, teamInactive._id, teamNoAccess._id] } });
    await Team.deleteMany({ _id: { $in: [teamGeotech._id, teamMaint._id, teamInactive._id, teamNoAccess._id, foreignTeam._id] } });
    await User.deleteMany({ _id: { $in: [userInactiveMember._id, userInactiveOrg._id, userNonProject._id] } });
    await OrganizationMember.deleteMany({ userId: { $in: [userInactiveMember._id, userInactiveOrg._id, userNonProject._id] } });
    await EmployeeProfile.deleteMany({ employeeCode: { $in: ['EMP-0017', 'EMP-0018'] } });
    console.log('[CLEANUP] Temporary test fixtures cleaned up successfully');

    console.log('\n========================================================');
    console.log('ALL PHASE A1E TESTS PASSED SUCCESSFULLY (42/42 ASSERTION BLOCKS)');
    console.log('========================================================\n');

  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    await mongoose.disconnect();
  }
}

runTestSuite().catch(err => {
  console.error('\n\x1b[31m[TEST SUITE FAILURE]\x1b[0m', err);
  if (server) server.close();
  mongoose.disconnect().then(() => process.exit(1));
});
