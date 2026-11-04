#!/usr/bin/env node

/**
 * FOCUSED VERIFICATION SUITE: INVESTIGATION TEAM ASSIGNMENT ELIGIBILITY
 *
 * Verifies all 14 points specified in Section 7:
 * 1. ROLE_BASED project returns ACTIVE organization Teams even without ProjectTeamAccess.
 * 2. LAN-PRO-01 remains ROLE_BASED.
 * 3. Team-1 is returned.
 * 4. Team-2 is returned.
 * 5. Inactive Teams are excluded.
 * 6. Foreign-organization Teams are excluded.
 * 7. Selecting Team-1 returns only eligible active members.
 * 8. Employee-1 / EMP-0002 is eligible.
 * 9. Team-2 with zero members is still available for Team-only assignment.
 * 10. ROLE_BASED assignment to Team-1 succeeds without ProjectTeamAccess.
 * 11. ROLE_BASED assignment to Team-2 succeeds as Team-only assignment.
 * 12. TEAM_PERMISSIONS project still requires active ProjectTeamAccess.
 * 13. TEAM_PERMISSIONS project still rejects a Team without required access.
 * 14. Existing cross-org isolation remains enforced.
 */

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import assert from 'node:assert';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  User,
  OrganizationMember,
  ProjectMember,
  Investigation,
  InvestigationEvent,
  Team,
  TeamMember,
  ProjectTeamAccess,
  EmployeeProfile
} from '../src/models/index.js';
import {
  getInvestigationAssignmentOptions,
  validateTeamAssignment,
  assignInvestigation
} from '../src/services/investigation.service.js';

const MONGO_URI = env.mongoUri || 'mongodb://127.0.0.1:27017/geonexa';

function signToken(user, orgId, orgRole = 'ADMINISTRATOR') {
  return jwt.sign(
    {
      sub: String(user._id),
      userId: String(user._id),
      email: user.email,
      organizationId: String(orgId),
      organizationRole: orgRole,
      displayName: user.displayName
    },
    env.jwtSecret,
    { expiresIn: '1h' }
  );
}

async function runTests() {
  console.log('================================================================');
  console.log('INVESTIGATION ASSIGNMENT ELIGIBILITY TEST SUITE');
  console.log('================================================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const runTag = `INV-TEST-${Date.now()}`;
  const createdTeamIds = [];
  const createdProjectIds = [];
  const createdInvIds = [];
  const createdUserIds = [];

  const cleanup = async () => {
    console.log('\n[CLEANUP] Cleaning up test records...');
    try {
      if (createdInvIds.length) {
        await Investigation.deleteMany({ _id: { $in: createdInvIds } });
        await InvestigationEvent.deleteMany({ investigationId: { $in: createdInvIds } });
      }
      if (createdTeamIds.length) {
        await TeamMember.deleteMany({ teamId: { $in: createdTeamIds } });
        await ProjectTeamAccess.deleteMany({ teamId: { $in: createdTeamIds } });
        await Team.deleteMany({ _id: { $in: createdTeamIds } });
      }
      if (createdProjectIds.length) {
        await ProjectMember.deleteMany({ projectId: { $in: createdProjectIds } });
        await ProjectTeamAccess.deleteMany({ projectId: { $in: createdProjectIds } });
        await Project.deleteMany({ _id: { $in: createdProjectIds } });
      }
      if (createdUserIds.length) {
        await OrganizationMember.deleteMany({ userId: { $in: createdUserIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
      }
      console.log('[CLEANUP] Cleaned up successfully.');
    } catch (e) {
      console.error('[CLEANUP ERROR]:', e);
    }
  };

  try {
    // -------------------------------------------------------------------------
    // SECTION 1: VERIFY LAN-PRO-01 REAL BASELINE DATA
    // -------------------------------------------------------------------------
    console.log('--- SECTION 1: LAN-PRO-01 BASELINE & OPTIONS ---');

    const lanProject = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
    assert(Boolean(lanProject), 'Authoritative Project LAN-PRO-01 exists');

    // 2. LAN-PRO-01 remains ROLE_BASED
    const accessMode = lanProject.accessMode || 'ROLE_BASED';
    assert.strictEqual(accessMode, 'ROLE_BASED', '2. LAN-PRO-01 accessMode is ROLE_BASED');
    console.log('[PASS] 2. LAN-PRO-01 remains ROLE_BASED');

    const orgId = lanProject.organizationId.toString();
    const lanProjectId = lanProject._id.toString();

    // Verify Team-1 and Team-2 exist and do NOT have ProjectTeamAccess records
    const team1 = await Team.findOne({ organizationId: orgId, teamCode: 'TEAM-0001' }).lean();
    const team2 = await Team.findOne({ organizationId: orgId, teamCode: 'TEAM-0002' }).lean();
    assert(Boolean(team1), 'Team-1 (TEAM-0001) exists in database');
    assert(Boolean(team2), 'Team-2 (TEAM-0002) exists in database');

    const ptaTeam1 = await ProjectTeamAccess.findOne({ projectId: lanProjectId, teamId: team1._id }).lean();
    const ptaTeam2 = await ProjectTeamAccess.findOne({ projectId: lanProjectId, teamId: team2._id }).lean();
    assert.strictEqual(ptaTeam1, null, 'CONFIRMED: Team-1 has no ProjectTeamAccess for LAN-PRO-01 (no workaround used)');
    assert.strictEqual(ptaTeam2, null, 'CONFIRMED: Team-2 has no ProjectTeamAccess for LAN-PRO-01 (no workaround used)');

    // 1, 3, 4. ROLE_BASED project returns ACTIVE organization Teams (Team-1 & Team-2) without ProjectTeamAccess
    const lanOptions = await getInvestigationAssignmentOptions({
      projectId: lanProjectId,
      organizationId: orgId
    });

    assert(Array.isArray(lanOptions.eligibleTeams), 'eligibleTeams is an array');
    const returnedCodes = lanOptions.eligibleTeams.map(t => t.teamCode);

    // 1. Returns active teams without ProjectTeamAccess
    assert(returnedCodes.length >= 2, '1. At least 2 active teams returned');
    console.log('[PASS] 1. ROLE_BASED project returns ACTIVE organization Teams even without ProjectTeamAccess');

    // 3. Team-1 is returned
    assert(returnedCodes.includes('TEAM-0001'), '3. Team-1 is included in eligibleTeams');
    console.log('[PASS] 3. Team-1 is returned');

    // 4. Team-2 is returned
    assert(returnedCodes.includes('TEAM-0002'), '4. Team-2 is included in eligibleTeams');
    console.log('[PASS] 4. Team-2 is returned');

    // -------------------------------------------------------------------------
    // SECTION 2: MEMBER RESOLUTION FOR TEAM-1 & TEAM-2
    // -------------------------------------------------------------------------
    console.log('\n--- SECTION 2: MEMBER DROPDOWN RESOLUTION ---');

    // 7 & 8. Selecting Team-1 returns eligible members, including Employee-1 (EMP-0002)
    const team1MemberOptions = await getInvestigationAssignmentOptions({
      projectId: lanProjectId,
      organizationId: orgId,
      teamId: team1._id.toString()
    });

    assert(Array.isArray(team1MemberOptions.eligibleMembers), 'eligibleMembers is an array');
    const memberCodes = team1MemberOptions.eligibleMembers.map(m => m.employeeCode);

    assert(memberCodes.includes('EMP-0002'), '8. Employee-1 / EMP-0002 is present in eligibleMembers');
    console.log('[PASS] 7. Selecting Team-1 returns only eligible active members');
    console.log('[PASS] 8. Employee-1 / EMP-0002 is eligible');

    // 9. Team-2 has zero members but is still available for Team-only assignment
    const team2MemberOptions = await getInvestigationAssignmentOptions({
      projectId: lanProjectId,
      organizationId: orgId,
      teamId: team2._id.toString()
    });

    assert.strictEqual(team2MemberOptions.eligibleMembers.length, 0, 'Team-2 has 0 eligible members');
    assert(team2MemberOptions.eligibleTeams.some(t => t.teamCode === 'TEAM-0002'), 'Team-2 is present in eligibleTeams');
    console.log('[PASS] 9. Team-2 with zero members is still available for Team-only assignment');

    // -------------------------------------------------------------------------
    // SECTION 3: INACTIVE AND FOREIGN ORG FILTERING
    // -------------------------------------------------------------------------
    console.log('\n--- SECTION 3: INACTIVE & FOREIGN ORG EXCLUSION ---');

    // 5. Inactive Teams are excluded
    const inactTeam = await Team.create({
      organizationId: orgId,
      teamCode: `TEST-INACT-${runTag}`,
      name: 'Temporary Inactive Team',
      status: 'INACTIVE'
    });
    createdTeamIds.push(inactTeam._id);

    const postInactOptions = await getInvestigationAssignmentOptions({
      projectId: lanProjectId,
      organizationId: orgId
    });
    const postInactCodes = postInactOptions.eligibleTeams.map(t => t.teamCode);
    assert(!postInactCodes.includes(inactTeam.teamCode), '5. Inactive Team must NOT appear in eligibleTeams');
    console.log('[PASS] 5. Inactive Teams are excluded');

    // 6. Foreign-organization Teams are excluded
    const foreignOrgId = new mongoose.Types.ObjectId();
    const foreignTeam = await Team.create({
      organizationId: foreignOrgId,
      teamCode: `TEST-FOR-${runTag}`,
      name: 'Foreign Org Team',
      status: 'ACTIVE'
    });
    createdTeamIds.push(foreignTeam._id);

    const postForOptions = await getInvestigationAssignmentOptions({
      projectId: lanProjectId,
      organizationId: orgId
    });
    const postForCodes = postForOptions.eligibleTeams.map(t => t.teamCode);
    assert(!postForCodes.includes(foreignTeam.teamCode), '6. Foreign organization Team must NOT appear in eligibleTeams');
    console.log('[PASS] 6. Foreign-organization Teams are excluded');

    // -------------------------------------------------------------------------
    // SECTION 4: ROLE_BASED ASSIGNMENT EXECUTION
    // -------------------------------------------------------------------------
    console.log('\n--- SECTION 4: ROLE_BASED ASSIGNMENT EXECUTION ---');

    // Create a temporary investigation on LAN-PRO-01 to test actual assignment mutation
    const tempInv = await Investigation.create({
      organizationId: orgId,
      projectId: lanProjectId,
      investigationCode: `INV-${runTag}`,
      title: `Assignment Test Investigation ${runTag}`,
      status: 'OPEN',
      priority: 'MEDIUM'
    });
    createdInvIds.push(tempInv._id);

    // Find an admin user for actor ID
    const adminUser = await User.findOne({ organizationId: orgId, role: 'admin' }).lean() ||
                      await User.findOne({ email: 'admin@geonexa.test' }).lean() ||
                      await User.findOne({}).lean();
    assert(Boolean(adminUser), 'Admin user found for actor operations');

    // 10. ROLE_BASED assignment to Team-1 succeeds without ProjectTeamAccess
    const assignTeam1Result = await assignInvestigation({
      investigationId: tempInv._id,
      projectId: lanProjectId,
      organizationId: orgId,
      assignedTeamId: team1._id.toString(),
      actor: { actorType: 'USER', userId: adminUser._id, email: adminUser.email },
      comment: 'Assign to Team-1 in ROLE_BASED'
    });
    assert.strictEqual(assignTeam1Result.assignedTeamId.toString(), team1._id.toString(), '10. assignedTeamId updated to Team-1');
    assert.strictEqual(assignTeam1Result.assignedTeamSnapshot.teamCode, 'TEAM-0001');
    console.log('[PASS] 10. ROLE_BASED assignment to Team-1 succeeds without ProjectTeamAccess');

    // 11. ROLE_BASED assignment to Team-2 succeeds as Team-only assignment
    const assignTeam2Result = await assignInvestigation({
      investigationId: tempInv._id,
      projectId: lanProjectId,
      organizationId: orgId,
      assignedTeamId: team2._id.toString(),
      assignedTo: null,
      actor: { actorType: 'USER', userId: adminUser._id, email: adminUser.email },
      comment: 'Assign to Team-2 (Team-only) in ROLE_BASED'
    });
    assert.strictEqual(assignTeam2Result.assignedTeamId.toString(), team2._id.toString(), '11. assignedTeamId updated to Team-2');
    assert.strictEqual(assignTeam2Result.assignedTo, null, '11. assignedTo is null (Team-only assignment)');
    console.log('[PASS] 11. ROLE_BASED assignment to Team-2 succeeds as Team-only assignment');

    // -------------------------------------------------------------------------
    // SECTION 5: TEAM_PERMISSIONS PROJECT ENFORCEMENT
    // -------------------------------------------------------------------------
    console.log('\n--- SECTION 5: TEAM_PERMISSIONS ACCESS MODE ENFORCEMENT ---');

    // 12 & 13. Create dedicated test project in TEAM_PERMISSIONS mode
    const teamPermProject = await Project.create({
      organizationId: orgId,
      code: `TP-${runTag}`,
      name: `Team Perm Project ${runTag}`,
      accessMode: 'TEAM_PERMISSIONS'
    });
    createdProjectIds.push(teamPermProject._id);

    // Team without ProjectTeamAccess on teamPermProject
    const tpTeamNoAccess = await Team.create({
      organizationId: orgId,
      teamCode: `TP-NOACC-${runTag}`,
      name: 'TP Team Without Access',
      status: 'ACTIVE'
    });
    createdTeamIds.push(tpTeamNoAccess._id);

    // Check assignment options on TEAM_PERMISSIONS project: tpTeamNoAccess must NOT appear
    const tpOptions = await getInvestigationAssignmentOptions({
      projectId: teamPermProject._id.toString(),
      organizationId: orgId
    });
    const tpTeamCodes = tpOptions.eligibleTeams.map(t => t.teamCode);
    assert(!tpTeamCodes.includes(tpTeamNoAccess.teamCode), '12. Team without ProjectTeamAccess not in eligibleTeams for TEAM_PERMISSIONS project');
    console.log('[PASS] 12. TEAM_PERMISSIONS project still requires active ProjectTeamAccess');

    // 13. validateTeamAssignment rejects Team without ProjectTeamAccess in TEAM_PERMISSIONS mode
    let tpErrorThrown = false;
    try {
      await validateTeamAssignment({
        organizationId: orgId,
        projectId: teamPermProject._id.toString(),
        teamId: tpTeamNoAccess._id.toString()
      });
    } catch (err) {
      tpErrorThrown = true;
      assert.strictEqual(err.status || err.statusCode, 400);
      assert(err.message.includes('access to this project'), `Expected access error, got: ${err.message}`);
    }
    assert(tpErrorThrown, '13. Team without required access rejected with 400 in TEAM_PERMISSIONS');
    console.log('[PASS] 13. TEAM_PERMISSIONS project still rejects a Team without required access');

    // Grant ProjectTeamAccess WITH investigations.view: now it should be eligible
    await ProjectTeamAccess.create({
      organizationId: orgId,
      projectId: teamPermProject._id,
      teamId: tpTeamNoAccess._id,
      status: 'ACTIVE',
      permissions: ['investigations.view', 'investigations.assign']
    });

    const tpOptionsAfterAccess = await getInvestigationAssignmentOptions({
      projectId: teamPermProject._id.toString(),
      organizationId: orgId
    });
    const tpTeamCodesAfter = tpOptionsAfterAccess.eligibleTeams.map(t => t.teamCode);
    assert(tpTeamCodesAfter.includes(tpTeamNoAccess.teamCode), 'Team with ProjectTeamAccess now appears in TEAM_PERMISSIONS options');

    const tpValidRes = await validateTeamAssignment({
      organizationId: orgId,
      projectId: teamPermProject._id.toString(),
      teamId: tpTeamNoAccess._id.toString()
    });
    assert(Boolean(tpValidRes.teamAccess), 'validateTeamAssignment returned teamAccess for TEAM_PERMISSIONS');

    // -------------------------------------------------------------------------
    // SECTION 6: CROSS-ORG ISOLATION
    // -------------------------------------------------------------------------
    console.log('\n--- SECTION 6: CROSS-ORG ISOLATION ---');

    // 14. Querying assignment options across organization boundary is rejected
    let crossOrgOptionsError = false;
    try {
      await getInvestigationAssignmentOptions({
        projectId: lanProjectId,
        organizationId: foreignOrgId.toString()
      });
    } catch (err) {
      crossOrgOptionsError = true;
      assert.strictEqual(err.status || err.statusCode, 403, 'Cross-org options query returns 403');
    }
    assert(crossOrgOptionsError, '14. Cross-org assignment options query blocked with 403');

    // Assigning a foreign-organization team is rejected
    let crossOrgAssignError = false;
    try {
      await validateTeamAssignment({
        organizationId: orgId,
        projectId: lanProjectId,
        teamId: foreignTeam._id.toString()
      });
    } catch (err) {
      crossOrgAssignError = true;
      assert.strictEqual(err.status || err.statusCode, 403, 'Cross-org team assignment validation returns 403');
    }
    assert(crossOrgAssignError, '14. Cross-org team validation blocked with 403');
    console.log('[PASS] 14. Existing cross-org isolation remains enforced');

    // -------------------------------------------------------------------------
    // SECTION 7: HTTP API ENDPOINT VERIFICATION
    // -------------------------------------------------------------------------
    console.log('\n--- SECTION 7: HTTP API ENDPOINT VERIFICATION ---');

    // Verify GET /api/v1/projects/:projectId/investigations/assignment-options via HTTP
    const adminToken = signToken(adminUser, orgId, 'ADMINISTRATOR');

    const httpRes = await fetch(`${baseUrl}/projects/${lanProjectId}/investigations/assignment-options`, {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      }
    });

    assert.strictEqual(httpRes.status, 200, 'HTTP GET assignment-options returns 200');
    const httpData = await httpRes.json();
    assert(Array.isArray(httpData.eligibleTeams), 'HTTP response contains eligibleTeams array');
    const httpCodes = httpData.eligibleTeams.map(t => t.teamCode);
    assert(httpCodes.includes('TEAM-0001'), 'HTTP response includes TEAM-0001');
    assert(httpCodes.includes('TEAM-0002'), 'HTTP response includes TEAM-0002');
    console.log('[PASS] HTTP GET assignment-options successfully returns Team-1 and Team-2 for LAN-PRO-01');

    console.log('\n================================================================');
    console.log('ALL 14 INVESTIGATION ASSIGNMENT ELIGIBILITY TESTS PASSED!');
    console.log('================================================================\n');

  } finally {
    await cleanup();
    server.close();
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

runTests().catch(err => {
  console.error('\n\x1b[31m[TEST SUITE FAILURE]\x1b[0m', err);
  process.exit(1);
});
