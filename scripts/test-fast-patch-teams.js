import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Team, TeamMember, User, Organization } from '../src/models/index.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(message);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
}

async function runFastPatchVerification() {
  console.log('========================================================');
  console.log('FAST PATCH — TEAMS VERIFICATION SUITE');
  console.log('========================================================\n');

  await mongoose.connect(env.mongoUri);
  const app = createApp();
  const server = app.listen(3198);
  const BASE_URL = 'http://127.0.0.1:3198';

  try {
    const org = await Organization.findOne({ name: 'ORG-1' }) || await Organization.findOne({ code: 'ORG-1' }) || await Organization.findById('6ac4cce70f25c8b970d45596');
    assert(Boolean(org), 'ORG-1 organization exists');
    const orgId = String(org._id);

    const adminUser = await User.findOne({ email: 'org1@yopmail.com' });
    assert(Boolean(adminUser), 'Admin user org1@yopmail.com exists');

    const adminToken = jwt.sign(
      { organizationId: orgId, organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: String(adminUser._id), expiresIn: '2h' }
    );
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };

    // 1. Initial State: TEAM-0001
    console.log('\n--- 1. INITIAL STATE FOR TEAM-0001 ---');
    const team1 = await Team.findOne({ organizationId: org._id, teamCode: 'TEAM-0001' });
    assert(Boolean(team1), 'TEAM-0001 exists in database');
    const teamId = String(team1._id);

    const initialMembers = await TeamMember.find({ teamId: team1._id }).lean();
    assert(initialMembers.length === 2, `TEAM-0001 has exactly 2 members initially (got ${initialMembers.length})`);

    const person1Member = initialMembers.find(m => m.membershipRole === 'LEAD');
    const emp1Member = initialMembers.find(m => m.membershipRole === 'MEMBER');
    assert(Boolean(person1Member && person1Member.status === 'ACTIVE'), 'Person-1 is LEAD and ACTIVE');
    assert(Boolean(emp1Member && emp1Member.status === 'ACTIVE'), 'Employee-1 is MEMBER and ACTIVE');

    // Fetch Teams list via API
    const listRes1 = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams`, { headers });
    assert(listRes1.status === 200, 'GET /teams returned 200');
    const teamsList1 = await listRes1.json();
    const team1Item1 = teamsList1.find(t => t.teamCode === 'TEAM-0001');
    assert(team1Item1 && team1Item1.activeMemberCount === 2, `Initial activeMemberCount for TEAM-0001 is 2 (got ${team1Item1?.activeMemberCount})`);

    // 2. Step A: Deactivate Employee-1
    console.log('\n--- 2. STEP A: DEACTIVATE EMPLOYEE-1 ---');
    const emp1UserId = String(emp1Member.userId);
    const deactRes = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams/${teamId}/members/${emp1UserId}`, {
      method: 'DELETE',
      headers
    });
    assert(deactRes.status === 200, 'DELETE /members/:userId returned 200 (deactivated)');

    // Verify Team detail drawer data
    const detailResA = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams/${teamId}`, { headers });
    assert(detailResA.status === 200, 'GET /teams/:teamId returned 200');
    const detailDataA = await detailResA.json();
    const emp1DetailA = detailDataA.members.find(m => String(m.userId) === emp1UserId);
    assert(emp1DetailA && emp1DetailA.status === 'INACTIVE', 'Employee-1 status in roster is now INACTIVE');
    assert(emp1DetailA.membershipRole === 'MEMBER', 'Employee-1 role in roster remains MEMBER');

    // Verify Teams list data
    const listResA = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams`, { headers });
    const teamsListA = await listResA.json();
    const team1ItemA = teamsListA.find(t => t.teamCode === 'TEAM-0001');
    assert(team1ItemA && team1ItemA.activeMemberCount === 1, `Teams list activeMemberCount updated to 1 (got ${team1ItemA?.activeMemberCount})`);

    // 3. Step B: Reactivate Employee-1
    console.log('\n--- 3. STEP B: REACTIVATE EMPLOYEE-1 ---');
    const reactRes = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams/${teamId}/members/${emp1UserId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'ACTIVE' })
    });
    assert(reactRes.status === 200, 'PATCH /members/:userId with status: ACTIVE returned 200');
    const reactData = await reactRes.json();
    assert(reactData.status === 'ACTIVE', 'Reactivated member status is ACTIVE');

    // Verify duplicate was NOT created
    const membersAfterReactivate = await TeamMember.find({ teamId: team1._id }).lean();
    assert(membersAfterReactivate.length === 2, `No duplicate TeamMember created: total count remains 2 (got ${membersAfterReactivate.length})`);

    // Verify Teams list data
    const listResB = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams`, { headers });
    const teamsListB = await listResB.json();
    const team1ItemB = teamsListB.find(t => t.teamCode === 'TEAM-0001');
    assert(team1ItemB && team1ItemB.activeMemberCount === 2, `Teams list activeMemberCount updated to 2 (got ${team1ItemB?.activeMemberCount})`);

    // 4. Step C: Promote Employee-1 to LEAD
    console.log('\n--- 4. STEP C: PROMOTE EMPLOYEE-1 TO LEAD ---');
    const promoteRes = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams/${teamId}/members/${emp1UserId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ membershipRole: 'LEAD' })
    });
    assert(promoteRes.status === 200, 'PATCH /members/:userId with membershipRole: LEAD returned 200');
    const promoteData = await promoteRes.json();
    assert(promoteData.membershipRole === 'LEAD', 'Employee-1 role is now LEAD');

    const listResC = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams`, { headers });
    const teamsListC = await listResC.json();
    const team1ItemC = teamsListC.find(t => t.teamCode === 'TEAM-0001');
    assert(team1ItemC && team1ItemC.activeMemberCount === 2, `Active count remains 2 after promotion (got ${team1ItemC?.activeMemberCount})`);

    // 5. Step D: Demote Employee-1 back to MEMBER
    console.log('\n--- 5. STEP D: DEMOTE EMPLOYEE-1 BACK TO MEMBER ---');
    const demoteRes = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams/${teamId}/members/${emp1UserId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ membershipRole: 'MEMBER' })
    });
    assert(demoteRes.status === 200, 'PATCH /members/:userId with membershipRole: MEMBER returned 200');
    const demoteData = await demoteRes.json();
    assert(demoteData.membershipRole === 'MEMBER', 'Employee-1 role is now MEMBER');

    const listResD = await fetch(`${BASE_URL}/api/v1/organizations/${orgId}/teams`, { headers });
    const teamsListD = await listResD.json();
    const team1ItemD = teamsListD.find(t => t.teamCode === 'TEAM-0001');
    assert(team1ItemD && team1ItemD.activeMemberCount === 2, `Active count remains 2 after demotion (got ${team1ItemD?.activeMemberCount})`);

    // 6. Ensure team lead is Person-1
    await Team.findByIdAndUpdate(team1._id, { teamLeadUserId: person1Member.userId });
    await TeamMember.findByIdAndUpdate(person1Member._id, { membershipRole: 'LEAD', status: 'ACTIVE' });
    await TeamMember.findByIdAndUpdate(emp1Member._id, { membershipRole: 'MEMBER', status: 'ACTIVE' });

    console.log('\n========================================================');
    console.log('ALL FAST PATCH VERIFICATION CHECKS PASSED SUCCESSFULLY!');
    console.log('========================================================\n');
  } finally {
    server.close();
    await mongoose.disconnect();
  }
}

runFastPatchVerification().catch((err) => {
  console.error('\n\x1b[31m[FAST PATCH VERIFICATION FAILED]\x1b[0m', err);
  process.exit(1);
});
