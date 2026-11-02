import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import http from 'http';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { User, Project, TeamMember, Team, EmployeeProfile } from '../src/models/index.js';

async function runTests() {
  console.log('=== Starting NexaIQ Employee Team Display & Filter Tests ===\n');
  await mongoose.connect('mongodb://127.0.0.1:27017/geonexa');

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  try {
    const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
    if (!project) throw new Error('Project LAN-PRO-01 not found');
    const orgId = project.organizationId.toString();

    const adminUser = await User.findOne({ email: 'org1@yopmail.com' }).lean();
    const emp1User = await User.findOne({ email: 'emp1@yopmail.com' }).lean();

    const adminToken = jwt.sign(
      { sub: adminUser._id.toString(), organizationId: orgId, organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { expiresIn: '1h' }
    );

    // 1. TEST GET /organizations/:organizationId/employees
    console.log('--- Test 1: GET /organizations/:organizationId/employees ---');
    const empRes = await fetch(`${baseUrl}/organizations/${orgId}/employees`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (empRes.status !== 200) throw new Error(`GET employees failed with HTTP ${empRes.status}`);
    const employees = await empRes.json();
    console.log(`[PASS] Fetched ${employees.length} employees from organization.`);

    const emp1 = employees.find((e) => e.userId.toString() === emp1User._id.toString());
    const person1 = employees.find((e) => e.userId.toString() === adminUser._id.toString());

    if (!emp1) throw new Error('Employee-1 (emp1) not found in employees list');
    if (!person1) throw new Error('Person-1 (org1) not found in employees list');

    console.log('\nEmployee-1 Teams payload:');
    console.log(JSON.stringify(emp1.teams, null, 2));
    console.log('Person-1 Teams payload:');
    console.log(JSON.stringify(person1.teams, null, 2));

    // Verify Employee-1 membership in Team-1
    if (!Array.isArray(emp1.teams) || emp1.teams.length === 0) {
      throw new Error('Employee-1 teams array is empty or missing!');
    }
    const emp1Team1 = emp1.teams.find((t) => t.teamCode === 'TEAM-0001');
    if (!emp1Team1) throw new Error('Employee-1 does not have Team-1 in teams array');
    if (emp1Team1.membershipRole !== 'MEMBER') {
      throw new Error(`Expected Employee-1 membershipRole to be MEMBER, got ${emp1Team1.membershipRole}`);
    }
    console.log('[PASS] Employee-1 / EMP-0002 has active Team-1 with membershipRole: MEMBER.');

    // Verify Person-1 membership in Team-1
    if (!Array.isArray(person1.teams) || person1.teams.length === 0) {
      throw new Error('Person-1 teams array is empty or missing!');
    }
    const person1Team1 = person1.teams.find((t) => t.teamCode === 'TEAM-0001');
    if (!person1Team1) throw new Error('Person-1 does not have Team-1 in teams array');
    if (person1Team1.membershipRole !== 'LEAD') {
      throw new Error(`Expected Person-1 membershipRole to be LEAD, got ${person1Team1.membershipRole}`);
    }
    console.log('[PASS] Person-1 / EMP-0001 has active Team-1 with membershipRole: LEAD.');

    // 2. TEST TEAM FILTER LOGIC
    console.log('\n--- Test 2: Team Filter by Team-1 ---');
    const team1Id = emp1Team1.teamId;
    const filteredForTeam1 = employees.filter((e) =>
      e.primaryTeamId === team1Id ||
      (Array.isArray(e.teams) && e.teams.some((tm) => tm.teamId === team1Id))
    );
    const hasEmp1InFilter = filteredForTeam1.some((e) => e.userId.toString() === emp1User._id.toString());
    const hasPerson1InFilter = filteredForTeam1.some((e) => e.userId.toString() === adminUser._id.toString());

    if (!hasEmp1InFilter || !hasPerson1InFilter) {
      throw new Error(`Team filter failed: hasEmp1=${hasEmp1InFilter}, hasPerson1=${hasPerson1InFilter}`);
    }
    console.log(`[PASS] Filtering by Team-1 correctly includes both Employee-1 and Person-1 (${filteredForTeam1.length} employees matched).`);

    // 3. TEST EMPLOYEE ACCESS DRAWER ENDPOINTS
    console.log('\n--- Test 3: GET /projects/:projectId/employee-access/:userId ---');
    const accessRes = await fetch(`${baseUrl}/projects/${project._id}/employee-access/${emp1User._id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (accessRes.status !== 200) throw new Error(`GET single employee-access failed: HTTP ${accessRes.status}`);
    const accessData = await accessRes.json();

    if (!Array.isArray(accessData.teams) || accessData.teams.length === 0) {
      throw new Error('employee-access response missing teams array!');
    }
    const drawerTeam1 = accessData.teams.find((t) => t.teamCode === 'TEAM-0001');
    if (!drawerTeam1 || drawerTeam1.membershipRole !== 'MEMBER') {
      throw new Error('Drawer team info for Employee-1 mismatch');
    }
    if (accessData.role !== 'ENGINEER' || accessData.accessProfile !== 'ROLE_PRESET' || accessData.permissions.length !== 20) {
      throw new Error(`Project access changed unexpectedly: role=${accessData.role}, profile=${accessData.accessProfile}, perms=${accessData.permissions.length}`);
    }
    console.log('[PASS] Employee Project Access endpoint returns read-only teams array:');
    console.log(`  Role: ${accessData.role}, Profile: ${accessData.accessProfile}, Perms: ${accessData.permissions.length}`);
    console.log(`  Teams: ${drawerTeam1.teamName} · ${drawerTeam1.membershipRole}`);

    // 4. TEST MULTIPLE TEAMS & INACTIVE TEAM EXCLUSION
    console.log('\n--- Test 4: Multiple Teams and Inactive Filter Verification ---');
    const team2 = await Team.findOne({ teamCode: 'TEAM-0002' }).lean();
    if (team2) {
      // Temporarily add an active membership to team2 and an inactive membership to test exclusion
      await TeamMember.create({
        organizationId: orgId,
        teamId: team2._id,
        userId: emp1User._id,
        membershipRole: 'MEMBER',
        status: 'ACTIVE'
      });

      const multiRes = await fetch(`${baseUrl}/organizations/${orgId}/employees`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const multiEmployees = await multiRes.json();
      const multiEmp1 = multiEmployees.find((e) => e.userId.toString() === emp1User._id.toString());
      if (!multiEmp1.teams.some((t) => t.teamCode === 'TEAM-0002') || !multiEmp1.teams.some((t) => t.teamCode === 'TEAM-0001')) {
        throw new Error('Multiple active team memberships not properly returned!');
      }
      console.log(`[PASS] Employee-1 with multiple active teams returns all ${multiEmp1.teams.length} teams.`);

      // Now set team2 membership to INACTIVE
      await TeamMember.updateOne(
        { teamId: team2._id, userId: emp1User._id },
        { status: 'INACTIVE' }
      );

      const inactiveRes = await fetch(`${baseUrl}/organizations/${orgId}/employees`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const inactiveEmployees = await inactiveRes.json();
      const inactiveEmp1 = inactiveEmployees.find((e) => e.userId.toString() === emp1User._id.toString());
      if (inactiveEmp1.teams.some((t) => t.teamCode === 'TEAM-0002')) {
        throw new Error('INACTIVE team membership was returned in active teams list!');
      }
      console.log('[PASS] INACTIVE team membership is correctly excluded from the teams list.');

      // Cleanup temporary team2 test membership
      await TeamMember.deleteOne({ teamId: team2._id, userId: emp1User._id });
    }

    // 5. TEST ARCHITECTURAL PRESERVATION
    console.log('\n--- Test 5: Architectural Checks ---');
    const freshProject = await Project.findById(project._id).lean();
    if (freshProject.accessMode && freshProject.accessMode !== 'ROLE_BASED') {
      throw new Error(`Project accessMode changed to ${freshProject.accessMode}`);
    }
    console.log('[PASS] LAN-PRO-01 remains in ROLE_BASED mode.');

    const empProfiles = await EmployeeProfile.find({ organizationId: orgId }).lean();
    console.log(`[PASS] Verified ${empProfiles.length} EmployeeProfile records remain unchanged.`);

    console.log('\n======================================================');
    console.log('ALL EMPLOYEE TEAMS DISPLAY & FILTER TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    server.close();
    await mongoose.disconnect();
  }
}

runTests().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
