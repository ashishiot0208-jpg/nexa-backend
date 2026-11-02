import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import http from 'http';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { User, Project, ProjectMember, TeamMember, Team, Alarm, Investigation } from '../src/models/index.js';
import { ROLE_PRESETS, ALL_PERMISSION_KEYS } from '../src/config/permissions.js';

async function runTests() {
  console.log('=== Starting NexaIQ Canonical Role Preset & Employee Access Tests ===\n');
  await mongoose.connect('mongodb://127.0.0.1:27017/geonexa');

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;
  console.log(`Test server running at ${baseUrl}`);

  try {
    // 1. Identify project and test users
    const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
    if (!project) throw new Error('Project LAN-PRO-01 not found');
    console.log(`[PASS] Project found: ${project.name} (${project.code}), accessMode: ${project.accessMode || 'ROLE_BASED'}`);

    const adminUser = await User.findOne({ email: 'org1@yopmail.com' }).lean();
    if (!adminUser) throw new Error('Admin user org1@yopmail.com not found');

    const emp1User = await User.findOne({ email: 'emp1@yopmail.com' }).lean();
    if (!emp1User) throw new Error('Employee emp1@yopmail.com not found');

    const engineer2User = await User.findOne({ email: 'engineer@geonexa.test' }).lean();
    if (!engineer2User) throw new Error('Engineer engineer@geonexa.test not found');

    const operatorUser = await User.findOne({ email: 'operator@geonexa.test' }).lean();
    if (!operatorUser) throw new Error('Operator operator@geonexa.test not found');

    const viewerUser = await User.findOne({ email: 'viewer@geonexa.test' }).lean();
    if (!viewerUser) throw new Error('Viewer viewer@geonexa.test not found');

    // Create JWT tokens
    const adminToken = jwt.sign(
      { sub: adminUser._id.toString(), organizationId: project.organizationId.toString(), organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { expiresIn: '1h' }
    );

    const emp1Token = jwt.sign(
      { sub: emp1User._id.toString(), organizationId: project.organizationId.toString(), organizationRole: 'ENGINEER' },
      env.jwtSecret,
      { expiresIn: '1h' }
    );

    const engineer2Token = jwt.sign(
      { sub: engineer2User._id.toString(), organizationId: project.organizationId.toString(), organizationRole: 'ENGINEER' },
      env.jwtSecret,
      { expiresIn: '1h' }
    );

    const operatorToken = jwt.sign(
      { sub: operatorUser._id.toString(), organizationId: project.organizationId.toString(), organizationRole: 'OPERATOR' },
      env.jwtSecret,
      { expiresIn: '1h' }
    );

    const viewerToken = jwt.sign(
      { sub: viewerUser._id.toString(), organizationId: project.organizationId.toString(), organizationRole: 'VIEWER' },
      env.jwtSecret,
      { expiresIn: '1h' }
    );

    // Initial TeamMember snapshot for emp1User
    const initialTeamMemberships = await TeamMember.find({ userId: emp1User._id }).lean();
    console.log(`[PASS] Initial Team memberships for emp1: ${initialTeamMemberships.length}`);

    // Snapshot existing Alarm and Investigation IDs for direct endpoint testing
    const alarm = await Alarm.findOne({ projectId: project._id }).lean();
    const inv = await Investigation.findOne({ projectId: project._id }).lean();
    const alarmId = alarm?._id.toString() || '6ac64b0f222202652768acaf';
    const invId = inv?._id.toString() || '6ac64b0f222202652768acaf';

    // ------------------------------------------------------------------------
    // SECTION 1: VERIFY EXACT CANONICAL ROLE PRESET COUNTS
    // ------------------------------------------------------------------------
    console.log('\n--- Section 1: Canonical Role Preset Counts ---');
    console.log(`ADMINISTRATOR preset count: ${ROLE_PRESETS.ADMINISTRATOR.length} (expected 42)`);
    console.log(`ENGINEER preset count: ${ROLE_PRESETS.ENGINEER.length} (expected 24)`);
    console.log(`OPERATOR preset count: ${ROLE_PRESETS.OPERATOR.length} (expected 17)`);
    console.log(`VIEWER preset count: ${ROLE_PRESETS.VIEWER.length} (expected 11)`);

    if (ROLE_PRESETS.ADMINISTRATOR.length !== 42) throw new Error(`ADMINISTRATOR preset has ${ROLE_PRESETS.ADMINISTRATOR.length}, expected 42`);
    if (ROLE_PRESETS.ENGINEER.length !== 24) throw new Error(`ENGINEER preset has ${ROLE_PRESETS.ENGINEER.length}, expected 24`);
    if (ROLE_PRESETS.OPERATOR.length !== 17) throw new Error(`OPERATOR preset has ${ROLE_PRESETS.OPERATOR.length}, expected 17`);
    if (ROLE_PRESETS.VIEWER.length !== 11) throw new Error(`VIEWER preset has ${ROLE_PRESETS.VIEWER.length}, expected 11`);
    console.log('[PASS] All role preset counts match exact target specifications.');

    // Verify GET /projects/:projectId/access-permissions returns these exact presets
    const catalogRes = await fetch(`${baseUrl}/projects/${project._id}/access-permissions`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const catalogData = await catalogRes.json();
    if (catalogData.rolePresets.ADMINISTRATOR.length !== 42 ||
        catalogData.rolePresets.ENGINEER.length !== 24 ||
        catalogData.rolePresets.OPERATOR.length !== 17 ||
        catalogData.rolePresets.VIEWER.length !== 11) {
      throw new Error('access-permissions returned mismatched rolePresets counts');
    }
    console.log('[PASS] GET /access-permissions serves exact 42/25/17/11 role presets.');

    // ------------------------------------------------------------------------
    // SECTION 2: VERIFY ADMINISTRATOR BEHAVIOR
    // ------------------------------------------------------------------------
    console.log('\n--- Section 2: Administrator Override & Protection ---');
    const adminEffRes = await fetch(`${baseUrl}/projects/${project._id}/effective-permissions`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const adminEffData = await adminEffRes.json();
    if (!adminEffData.isAdministrator || adminEffData.permissions.length !== 42) {
      throw new Error(`Admin override failed: isAdministrator=${adminEffData.isAdministrator}, count=${adminEffData.permissions.length}`);
    }
    console.log('[PASS] Administrator has full project override with all 42 permissions.');

    // Verify restriction attempt on Administrator is disallowed/ignored
    const adminPatchRes = await fetch(`${baseUrl}/projects/${project._id}/employee-access/${adminUser._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'ADMINISTRATOR',
        accessProfile: 'CUSTOM',
        permissions: ['overview.view']
      })
    });
    const adminPatchData = await adminPatchRes.json();
    if (adminPatchData.accessProfile !== 'ADMINISTRATOR' || adminPatchData.permissions.length !== 42) {
      throw new Error(`Administrator permissions were restricted! Got ${adminPatchData.permissions.length} perms`);
    }
    console.log('[PASS] Administrator permissions cannot be restricted; retains full 42 override.');

    // ------------------------------------------------------------------------
    // SECTION 3: VERIFY ENGINEER PRESET & ENFORCEMENT
    // ------------------------------------------------------------------------
    console.log('\n--- Section 3: Engineer Preset & Enforcement ---');
    // Ensure emp1 is on default ENGINEER preset
    await fetch(`${baseUrl}/projects/${project._id}/employee-access/${emp1User._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'ENGINEER', accessProfile: 'ROLE_PRESET' })
    });

    const emp1EffRes = await fetch(`${baseUrl}/projects/${project._id}/effective-permissions`, {
      headers: { Authorization: `Bearer ${emp1Token}` }
    });
    const emp1EffData = await emp1EffRes.json();
    if (emp1EffData.permissions.length !== 24) {
      throw new Error(`Expected ENGINEER to have 24 permissions, got ${emp1EffData.permissions.length}`);
    }
    if (emp1EffData.permissions.includes('tasks.create')) {
      throw new Error('Default ENGINEER must NOT have tasks.create');
    }
    if (emp1EffData.permissions.includes('alarms.resolve')) {
      throw new Error('Default ENGINEER must NOT have alarms.resolve');
    }
    if (emp1EffData.permissions.includes('investigations.assign')) {
      throw new Error('Default ENGINEER must NOT have investigations.assign');
    }
    if (!emp1EffData.permissions.includes('alarms.acknowledge') ||
        !emp1EffData.permissions.includes('investigations.start') ||
        !emp1EffData.permissions.includes('investigations.addFinding') ||
        !emp1EffData.permissions.includes('investigations.complete') ||
        !emp1EffData.permissions.includes('tasks.view') ||
        !emp1EffData.permissions.includes('tasks.start') ||
        !emp1EffData.permissions.includes('tasks.update') ||
        !emp1EffData.permissions.includes('tasks.complete')) {
      throw new Error('Default ENGINEER missing expected operational permissions');
    }
    console.log(`[PASS] Default ENGINEER has exactly 24 permissions with correct operational subset.`);

    // 3a. Resolve alarm direct API attempt -> 403
    const engResolveRes = await fetch(`${baseUrl}/projects/${project._id}/alarms/${alarmId}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolutionNotes: 'Test' })
    });
    if (engResolveRes.status !== 403) throw new Error(`Expected 403 for engineer alarms.resolve, got ${engResolveRes.status}`);
    console.log(`[PASS] Engineer alarms.resolve rejected with HTTP 403.`);

    // 3b. Reassign investigation direct API attempt -> 403
    const engAssignRes = await fetch(`${baseUrl}/projects/${project._id}/investigations/${invId}/assign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadInvestigatorUserId: emp1User._id.toString() })
    });
    if (engAssignRes.status !== 403) throw new Error(`Expected 403 for engineer investigations.assign, got ${engAssignRes.status}`);
    console.log(`[PASS] Engineer investigations.assign rejected with HTTP 403.`);

    // 3c. Allowed actions succeed (alarms.view -> 200, investigations.view -> 200)
    const engAlarmsRes = await fetch(`${baseUrl}/projects/${project._id}/alarms`, {
      headers: { Authorization: `Bearer ${emp1Token}` }
    });
    if (engAlarmsRes.status !== 200) throw new Error(`Expected 200 for engineer alarms.view, got ${engAlarmsRes.status}`);

    const engInvsRes = await fetch(`${baseUrl}/projects/${project._id}/investigations`, {
      headers: { Authorization: `Bearer ${emp1Token}` }
    });
    if (engInvsRes.status !== 200) throw new Error(`Expected 200 for engineer investigations.view, got ${engInvsRes.status}`);
    console.log(`[PASS] Engineer alarms.view and investigations.view allowed (HTTP 200).`);

    // ------------------------------------------------------------------------
    // SECTION 4: VERIFY OPERATOR PRESET & ENFORCEMENT
    // ------------------------------------------------------------------------
    console.log('\n--- Section 4: Operator Preset & Enforcement ---');
    const opEffRes = await fetch(`${baseUrl}/projects/${project._id}/effective-permissions`, {
      headers: { Authorization: `Bearer ${operatorToken}` }
    });
    const opEffData = await opEffRes.json();
    if (opEffData.permissions.length !== 17) {
      throw new Error(`Expected OPERATOR to have 17 permissions, got ${opEffData.permissions.length}`);
    }
    if (opEffData.permissions.includes('severityRules.view') ||
        opEffData.permissions.includes('severityRules.configure') ||
        opEffData.permissions.includes('alarmPolicies.view') ||
        opEffData.permissions.includes('alarmPolicies.configure') ||
        opEffData.permissions.includes('alarms.resolve') ||
        opEffData.permissions.includes('investigations.complete') ||
        opEffData.permissions.includes('reports.export') ||
        opEffData.permissions.includes('tasks.create') ||
        opEffData.permissions.includes('tasks.assign') ||
        opEffData.permissions.includes('tasks.cancel')) {
      throw new Error('OPERATOR contains unauthorized permissions');
    }
    console.log(`[PASS] OPERATOR has exactly 17 permissions with engineering and administration excluded.`);

    // 4a. Operator configure severity rule -> 403
    const opSevRes = await fetch(`${baseUrl}/projects/${project._id}/severity-rules`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' })
    });
    if (opSevRes.status !== 403) throw new Error(`Expected 403 for operator severity-rules configure, got ${opSevRes.status}`);
    console.log(`[PASS] Operator severity rule configure rejected with HTTP 403.`);

    // 4b. Operator configure alarm policy -> 403
    const opPolicyRes = await fetch(`${baseUrl}/projects/${project._id}/alarm-policies`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' })
    });
    if (opPolicyRes.status !== 403) throw new Error(`Expected 403 for operator alarm policy configure, got ${opPolicyRes.status}`);
    console.log(`[PASS] Operator alarm policy configure rejected with HTTP 403.`);

    // 4c. Operator resolve alarm -> 403
    const opResolveRes = await fetch(`${baseUrl}/projects/${project._id}/alarms/${alarmId}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolutionNotes: 'Test' })
    });
    if (opResolveRes.status !== 403) throw new Error(`Expected 403 for operator alarms.resolve, got ${opResolveRes.status}`);
    console.log(`[PASS] Operator resolve alarm rejected with HTTP 403.`);

    // 4d. Operator administration view -> 403
    const opAdminRes = await fetch(`${baseUrl}/projects/${project._id}/employee-access`, {
      headers: { Authorization: `Bearer ${operatorToken}` }
    });
    if (opAdminRes.status !== 403) throw new Error(`Expected 403 for operator administration.view, got ${opAdminRes.status}`);
    console.log(`[PASS] Operator administration view rejected with HTTP 403.`);

    // ------------------------------------------------------------------------
    // SECTION 5: VERIFY VIEWER PRESET & READ-ONLY ENFORCEMENT
    // ------------------------------------------------------------------------
    console.log('\n--- Section 5: Viewer Preset & Read-Only Enforcement ---');
    const viewEffRes = await fetch(`${baseUrl}/projects/${project._id}/effective-permissions`, {
      headers: { Authorization: `Bearer ${viewerToken}` }
    });
    const viewEffData = await viewEffRes.json();
    if (viewEffData.permissions.length !== 11) {
      throw new Error(`Expected VIEWER to have 11 permissions, got ${viewEffData.permissions.length}`);
    }
    console.log(`[PASS] VIEWER has exactly 11 read-only permissions.`);

    // 5a. Viewer mutation attempt (alarms.acknowledge) -> 403
    const viewAckRes = await fetch(`${baseUrl}/projects/${project._id}/alarms/${alarmId}/acknowledge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Ack attempt' })
    });
    if (viewAckRes.status !== 403) throw new Error(`Expected 403 for viewer alarms.acknowledge, got ${viewAckRes.status}`);
    console.log(`[PASS] Viewer mutation (alarms.acknowledge) rejected with HTTP 403.`);

    // 5b. Viewer read-only access (alarms.view) -> 200
    const viewAlarmsRes = await fetch(`${baseUrl}/projects/${project._id}/alarms`, {
      headers: { Authorization: `Bearer ${viewerToken}` }
    });
    if (viewAlarmsRes.status !== 200) throw new Error(`Expected 200 for viewer alarms.view, got ${viewAlarmsRes.status}`);
    console.log(`[PASS] Viewer read-only (alarms.view) allowed with HTTP 200.`);

    // ------------------------------------------------------------------------
    // SECTION 6: VERIFY CUSTOM ACCESS PROFILE TRANSITIONS & USER ISOLATION
    // ------------------------------------------------------------------------
    console.log('\n--- Section 6: Custom Access Profile Transitions & Isolation ---');

    // 6a. Add alarms.resolve to emp1: Role remains ENGINEER, Profile becomes CUSTOM, 26 perms
    const customPerms = [...ROLE_PRESETS.ENGINEER, 'alarms.resolve'];
    const customPatchRes = await fetch(`${baseUrl}/projects/${project._id}/employee-access/${emp1User._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'ENGINEER',
        accessProfile: 'CUSTOM',
        permissions: customPerms
      })
    });
    const customPatchData = await customPatchRes.json();
    if (customPatchData.role !== 'ENGINEER' || customPatchData.accessProfile !== 'CUSTOM' || customPatchData.permissions.length !== 25) {
      throw new Error(`Expected ENGINEER with CUSTOM profile and 25 perms, got role=${customPatchData.role}, profile=${customPatchData.accessProfile}, perms=${customPatchData.permissions.length}`);
    }
    console.log('[PASS] Added alarms.resolve: Role remains ENGINEER, Access Profile becomes CUSTOM, Permissions: 25.');

    // 6b. Verify other Engineer (engineer@geonexa.test) is completely untouched
    const otherEngRes = await fetch(`${baseUrl}/projects/${project._id}/effective-permissions`, {
      headers: { Authorization: `Bearer ${engineer2Token}` }
    });
    const otherEngData = await otherEngRes.json();
    if (otherEngData.role !== 'ENGINEER' || otherEngData.accessProfile !== 'ROLE_PRESET' || otherEngData.permissions.length !== 24) {
      throw new Error(`Second Engineer was affected! Role=${otherEngData.role}, Profile=${otherEngData.accessProfile}, Perms=${otherEngData.permissions.length}`);
    }
    if (otherEngData.permissions.includes('alarms.resolve')) {
      throw new Error('Second Engineer received alarms.resolve unexpectedly!');
    }
    console.log('[PASS] Modifying emp1 did NOT affect second Engineer (engineer@geonexa.test retains 24 preset perms).');

    // 6c. Now remove alarms.resolve so permissions exactly match ENGINEER preset
    // Profile must automatically return to ROLE_PRESET
    const revertPerms = [...ROLE_PRESETS.ENGINEER];
    const revertPatchRes = await fetch(`${baseUrl}/projects/${project._id}/employee-access/${emp1User._id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'ENGINEER',
        permissions: revertPerms
      })
    });
    const revertPatchData = await revertPatchRes.json();
    if (revertPatchData.role !== 'ENGINEER' || revertPatchData.accessProfile !== 'ROLE_PRESET' || revertPatchData.permissions.length !== 24) {
      throw new Error(`Expected automatic return to ROLE_PRESET with 24 perms, got role=${revertPatchData.role}, profile=${revertPatchData.accessProfile}, perms=${revertPatchData.permissions.length}`);
    }
    console.log('[PASS] Removing alarms.resolve back to exact ENGINEER preset: Profile automatically returns to ROLE_PRESET (24 perms).');

    // ------------------------------------------------------------------------
    // SECTION 7: VERIFY ARCHITECTURAL INTEGRITY
    // ------------------------------------------------------------------------
    console.log('\n--- Section 7: Architectural Integrity ---');

    // 7a. Team membership unchanged
    const finalTeamMemberships = await TeamMember.find({ userId: emp1User._id }).lean();
    if (finalTeamMemberships.length !== initialTeamMemberships.length) {
      throw new Error('Team membership count changed!');
    }
    console.log(`[PASS] Team memberships intact (${finalTeamMemberships.length} active).`);

    // 7b. LAN-PRO-01 remains in ROLE_BASED mode
    const finalProject = await Project.findById(project._id).lean();
    if (finalProject.accessMode && finalProject.accessMode !== 'ROLE_BASED') {
      throw new Error(`Project accessMode changed to ${finalProject.accessMode}`);
    }
    console.log(`[PASS] LAN-PRO-01 remains in ROLE_BASED accessMode.`);

    console.log('\n======================================================');
    console.log('ALL CANONICAL ROLE PRESET & ACCESS TESTS PASSED!');
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
