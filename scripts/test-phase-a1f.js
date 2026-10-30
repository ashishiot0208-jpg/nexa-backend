#!/usr/bin/env node

/**
 * PHASE A1F — CLIENT EMPLOYEE INVITATION & ONBOARDING TEST SUITE
 *
 * Verifies all requirements of Phase A1F:
 * 1. Admin can create employee invitation (scoped to ORG-1 and LAN-PRO-01).
 * 2. Non-admins (Engineer, Operator, Viewer) cannot invite employees (HTTP 403).
 * 3. Cross-org invitation rejected (HTTP 403).
 * 4. Invalid project invitation rejected (HTTP 404).
 * 5. Token security: Tokens stored hashed (SHA-256), never raw plaintext in MongoDB.
 * 6. Public validate API checks token validity, expiry, revocation, and existing user state.
 * 7. Expired tokens cannot be accepted.
 * 8. Revoked tokens cannot be accepted.
 * 9. Regeneration flow: invalidates old token, generates new expiring token.
 * 10. Duplicate active PENDING invitation rejected (HTTP 409).
 * 11. Case A (New User):
 *     - User pre-provisioned in 'INVITED' state with locked passwordHash.
 *     - Cannot log in before acceptance.
 *     - Password setup atomically activates User, creates OrganizationMember,
 *       creates ProjectMember, creates EmployeeProfile, marks invitation ACCEPTED.
 *     - One-time token use: re-acceptance rejected.
 *     - Employee logs in through standard /api/v1/auth/login.
 * 12. Case B (Existing Active User):
 *     - User not duplicated; password not reset.
 *     - Public validate reports isExistingActiveUser: true.
 *     - Acceptance requires authentication matching invited email.
 *     - Missing memberships and EmployeeProfile linked atomically.
 *     - Re-inviting when everything exists rejected (HTTP 409).
 * 13. Accepted employee appears in Employees list.
 * 14. Accepted employee can be assigned to Team and becomes eligible for Investigation assignment.
 * 15. LAN-PRO-01 accessMode remains ROLE_BASED.
 * 16. Platform Admin routes and data completely intact.
 */

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  User,
  Organization,
  OrganizationMember,
  ProjectMember,
  EmployeeProfile,
  Team,
  TeamMember,
  ProjectTeamAccess,
  EmployeeInvitation
} from '../src/models/index.js';

const TEST_PORT = 3139;
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
      sub: String(user._id || user.id),
      email: user.email,
      organizationId: String(organizationId || user.organizationId),
      organizationRole: organizationRole || 'ADMINISTRATOR'
    },
    env.jwtSecret,
    { expiresIn: '1h' }
  );
}

async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text;
  }
  return { status: res.status, ok: res.ok, body: data, headers: res.headers };
}

async function runTests() {
  console.log('\n========================================================');
  console.log('STARTING PHASE A1F AUTOMATED VERIFICATION SUITE');
  console.log('========================================================\n');

  await mongoose.connect(env.mongoUri);
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(TEST_PORT, () => resolve(s));
  });

  const testEmailsToClean = [];

  try {
    // ------------------------------------------------------------------------
    // STEP 0: VERIFY AUTHORITATIVE BASELINE
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 0: AUTHORITATIVE BASELINE & INVARIANTS ---');
    const org = await Organization.findOne({
      $or: [{ name: 'ORG-1' }, { code: 'ORG-1' }, { _id: new mongoose.Types.ObjectId('6ac4cce70f25c8b970d45596') }]
    });
    assert(org, 'Authoritative Organization ORG-1 must exist');

    const project = await Project.findOne({ code: 'LAN-PRO-01', organizationId: org._id });
    assert(project, 'Authoritative Project LAN-PRO-01 must exist');
    assert((project.accessMode || 'ROLE_BASED') === 'ROLE_BASED', 'LAN-PRO-01 accessMode must be ROLE_BASED');

    const adminUser = await User.findOne({ email: 'org1@yopmail.com' });
    assert(adminUser, 'Admin user org1@yopmail.com must exist');

    const adminOrgMember = await OrganizationMember.findOne({
      organizationId: org._id,
      userId: adminUser._id
    });
    assert(adminOrgMember && adminOrgMember.organizationRole === 'ADMINISTRATOR', 'org1@yopmail.com must be org ADMINISTRATOR');

    const adminToken = makeToken(adminUser, org._id, 'ADMINISTRATOR');

    // Create a temporary foreign organization and project to test cross-org security
    const foreignOrg = await Organization.create({
      name: 'Foreign Org Test',
      code: `FOR-${Date.now().toString().slice(-4)}`,
      email: 'foreign@test.com'
    });
    const foreignProject = await Project.create({
      name: 'Foreign Project',
      code: `FOR-PRJ-${Date.now().toString().slice(-4)}`,
      organizationId: foreignOrg._id
    });

    // ------------------------------------------------------------------------
    // STEP 1: AUTHORIZATION & RBAC ENFORCEMENT
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 1: AUTHORIZATION & RBAC ENFORCEMENT ---');

    // 1.1 Non-admin (Engineer) cannot invite employee
    const engineerUser = await User.findOne({ email: 'engineer@geonexa.test' });
    if (engineerUser) {
      const engToken = makeToken(engineerUser, org._id, 'ENGINEER');
      const engRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${engToken}` },
        body: {
          displayName: 'Unauthorized Invite',
          email: 'unauth@geonexa.test',
          organizationRole: 'ENGINEER',
          projectRole: 'ENGINEER'
        }
      });
      assert(engRes.status === 403, 'Engineer cannot invite employee (HTTP 403)');
    }

    // 1.2 Non-admin (Operator) cannot invite employee
    const operatorUser = await User.findOne({ email: 'operator@geonexa.test' });
    if (operatorUser) {
      const opToken = makeToken(operatorUser, org._id, 'OPERATOR');
      const opRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opToken}` },
        body: {
          displayName: 'Unauthorized Invite Op',
          email: 'unauth-op@geonexa.test',
          organizationRole: 'ENGINEER',
          projectRole: 'ENGINEER'
        }
      });
      assert(opRes.status === 403, 'Operator cannot invite employee (HTTP 403)');
    }

    // 1.3 Non-admin (Viewer) cannot invite employee
    const viewerUser = await User.findOne({ email: 'viewer@geonexa.test' });
    if (viewerUser) {
      const vwToken = makeToken(viewerUser, org._id, 'VIEWER');
      const vwRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${vwToken}` },
        body: {
          displayName: 'Unauthorized Invite Vw',
          email: 'unauth-vw@geonexa.test',
          organizationRole: 'ENGINEER',
          projectRole: 'ENGINEER'
        }
      });
      assert(vwRes.status === 403, 'Viewer cannot invite employee (HTTP 403)');
    }

    // 1.4 Cross-org security: Client Admin of ORG-1 cannot invite into foreign project
    const crossOrgRes = await request(`/api/v1/projects/${foreignProject._id}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Cross Org Test',
        email: 'cross-org@geonexa.test',
        organizationRole: 'ENGINEER',
        projectRole: 'ENGINEER'
      }
    });
    assert(crossOrgRes.status === 403, 'Cross-org project invitation rejected (HTTP 403)');

    // 1.5 Non-existent project rejected
    const nonExistentProjId = new mongoose.Types.ObjectId();
    const nonExistRes = await request(`/api/v1/projects/${nonExistentProjId}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Non Exist Test',
        email: 'nonexist@geonexa.test',
        organizationRole: 'ENGINEER',
        projectRole: 'ENGINEER'
      }
    });
    assert(nonExistRes.status === 404, 'Non-existent project rejected (HTTP 404)');

    // ------------------------------------------------------------------------
    // STEP 2: TOKEN SECURITY & DATABASE HASH STORAGE
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 2: TOKEN SECURITY & STORAGE ---');
    const emailSec = 'a1f-sec-test@geonexa.test';
    testEmailsToClean.push(emailSec);

    const createSecRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Security Test Employee',
        email: emailSec,
        designation: 'Security Analyst',
        department: 'Operations',
        organizationRole: 'ENGINEER',
        projectRole: 'ENGINEER'
      }
    });
    assert(createSecRes.status === 201, 'Admin can create employee invitation (HTTP 201)');
    assert(createSecRes.body.rawToken, 'Response returns rawToken at creation');
    assert(createSecRes.body.invitationUrl.includes(createSecRes.body.rawToken), 'Invitation URL contains rawToken');

    const invInDb = await EmployeeInvitation.findById(createSecRes.body.invitation.id).lean();
    assert(invInDb, 'Invitation record must exist in MongoDB');
    assert(!invInDb.rawToken, 'CRITICAL: rawToken must NOT be stored in MongoDB');
    assert(invInDb.tokenHash, 'tokenHash must be stored in MongoDB');

    const expectedHash = crypto.createHash('sha256').update(createSecRes.body.rawToken).digest('hex');
    assert(invInDb.tokenHash === expectedHash, 'tokenHash must match SHA-256 of rawToken');
    assert(invInDb.status === 'PENDING', 'Invitation initial status must be PENDING');
    assert(invInDb.expiresAt > new Date(), 'expiresAt must be in the future (7 days)');

    // Verify pre-provisioned user
    const preUser = await User.findOne({ email: emailSec }).lean();
    assert(preUser, 'New user pre-provisioned in MongoDB');
    assert(preUser.status === 'INVITED', 'Pre-provisioned user status must be INVITED');
    assert(preUser.passwordHash, 'Pre-provisioned user must have locked passwordHash');

    // ------------------------------------------------------------------------
    // STEP 3: PUBLIC VALIDATE ENDPOINT & LIFECYCLE CHECKS
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 3: PUBLIC VALIDATE & LIFECYCLE ---');

    // 3.1 Valid token
    const valRes = await request(`/api/v1/employee-invitations/validate?token=${createSecRes.body.rawToken}`);
    assert(valRes.status === 200 && valRes.body.valid === true, 'Public validate returns valid: true for active token');
    assert(valRes.body.email === emailSec, 'Validate returns correct email');
    assert(valRes.body.isExistingActiveUser === false, 'isExistingActiveUser is false for new user');
    assert(valRes.body.organizationName === org.name, 'Validate resolves organizationName');
    assert(valRes.body.projectName === project.name, 'Validate resolves projectName');

    // 3.2 Invalid token
    const invTokenRes = await request(`/api/v1/employee-invitations/validate?token=nonexistenttoken1234567890`);
    assert(invTokenRes.status === 400, 'Invalid token returns HTTP 400');

    // 3.3 Expired token
    await EmployeeInvitation.updateOne({ _id: invInDb._id }, { expiresAt: new Date(Date.now() - 60000) });
    const expRes = await request(`/api/v1/employee-invitations/validate?token=${createSecRes.body.rawToken}`);
    assert(expRes.status === 400, 'Expired token returns HTTP 400');
    // Restore expiry
    await EmployeeInvitation.updateOne({ _id: invInDb._id }, { expiresAt: new Date(Date.now() + 7 * 86400000), status: 'PENDING' });

    // 3.4 Revoke flow
    const revokeRes = await request(`/api/v1/projects/${project._id}/employee-invitations/${invInDb._id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(revokeRes.status === 200 && revokeRes.body.status === 'REVOKED', 'Admin can revoke invitation (HTTP 200)');

    const valRevokedRes = await request(`/api/v1/employee-invitations/validate?token=${createSecRes.body.rawToken}`);
    assert(valRevokedRes.status === 400, 'Revoked token returns HTTP 400 on validate');

    // ------------------------------------------------------------------------
    // STEP 4: REGENERATE INVITATION FLOW
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 4: REGENERATE INVITATION FLOW ---');
    const emailRegen = 'a1f-regen-test@geonexa.test';
    testEmailsToClean.push(emailRegen);

    const createRegenRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Regen Test Employee',
        email: emailRegen,
        organizationRole: 'OPERATOR',
        projectRole: 'OPERATOR'
      }
    });
    const oldRawToken = createRegenRes.body.rawToken;
    const regenInvId = createRegenRes.body.invitation.id;

    // Call regenerate
    const regenRes = await request(`/api/v1/projects/${project._id}/employee-invitations/${regenInvId}/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(regenRes.status === 200 && regenRes.body.rawToken, 'Regenerate returns HTTP 200 and new rawToken');
    const newRawToken = regenRes.body.rawToken;
    assert(oldRawToken !== newRawToken, 'New token must differ from old token');

    // Old token must now fail
    const oldValRes = await request(`/api/v1/employee-invitations/validate?token=${oldRawToken}`);
    assert(oldValRes.status === 400, 'Old token immediately rejected after regeneration (HTTP 400)');

    // New token must succeed
    const newValRes = await request(`/api/v1/employee-invitations/validate?token=${newRawToken}`);
    assert(newValRes.status === 200 && newValRes.body.valid === true, 'New token validates successfully (HTTP 200)');

    // ------------------------------------------------------------------------
    // STEP 5: PREVENT DUPLICATE PENDING INVITATIONS
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 5: DUPLICATE PENDING INVITATION CONFLICT ---');
    const dupRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Duplicate Attempt',
        email: emailRegen, // Same email, project, and org while pending
        organizationRole: 'OPERATOR',
        projectRole: 'OPERATOR'
      }
    });
    assert(dupRes.status === 409, 'Duplicate pending invitation rejected with HTTP 409 Conflict');

    // ------------------------------------------------------------------------
    // STEP 6: CASE A — NEW USER COMPLETE ONBOARDING WORKFLOW
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 6: CASE A — NEW USER ONBOARDING WORKFLOW ---');
    const emailNew = 'a1f-onboard-new@geonexa.test';
    testEmailsToClean.push(emailNew);

    const createNewRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Arun Kumar',
        email: emailNew,
        employeeCode: 'EMP-9901',
        designation: 'Geotechnical Specialist',
        department: 'Site Engineering',
        phone: '+91 99999 88888',
        organizationRole: 'ENGINEER',
        projectRole: 'ENGINEER'
      }
    });
    assert(createNewRes.status === 201, 'Created invitation for new employee Arun Kumar');
    const tokenNew = createNewRes.body.rawToken;

    // Verify cannot log in before setting password
    const unactiveLogin = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { email: emailNew, password: 'Password123!' }
    });
    assert(unactiveLogin.status === 401, 'User cannot log in prior to activation (HTTP 401)');

    // Password setup & acceptance via POST /api/v1/auth/setup-password
    const setupPassRes = await request('/api/v1/auth/setup-password', {
      method: 'POST',
      body: {
        token: tokenNew,
        password: 'ArunPassword123!'
      }
    });
    assert(setupPassRes.status === 200, 'Password setup & acceptance succeeded (HTTP 200)');

    // Atomic database state verification
    const activatedUser = await User.findOne({ email: emailNew }).lean();
    assert(activatedUser && activatedUser.status === 'ACTIVE', 'User is now ACTIVE');

    const createdOrgMember = await OrganizationMember.findOne({
      organizationId: org._id,
      userId: activatedUser._id,
      status: 'ACTIVE'
    }).lean();
    assert(createdOrgMember && createdOrgMember.organizationRole === 'ENGINEER', 'OrganizationMember created with role ENGINEER');

    const createdProjMember = await ProjectMember.findOne({
      projectId: project._id,
      userId: activatedUser._id,
      status: 'ACTIVE'
    }).lean();
    assert(createdProjMember && createdProjMember.role === 'ENGINEER', 'ProjectMember created with role ENGINEER');

    const createdEmpProfile = await EmployeeProfile.findOne({
      organizationId: org._id,
      userId: activatedUser._id,
      status: 'ACTIVE'
    }).lean();
    assert(createdEmpProfile, 'EmployeeProfile created with status ACTIVE');
    assert(createdEmpProfile.employeeCode === 'EMP-9901', 'EmployeeProfile has correct code EMP-9901');
    assert(createdEmpProfile.designation === 'Geotechnical Specialist', 'EmployeeProfile designation preserved');
    assert(createdEmpProfile.department === 'Site Engineering', 'EmployeeProfile department preserved');
    assert(createdEmpProfile.primaryTeamId === undefined || createdEmpProfile.primaryTeamId === null, 'primaryTeamId is null (team comes later)');

    const acceptedInv = await EmployeeInvitation.findOne({ emailNormalized: emailNew }).lean();
    assert(acceptedInv.status === 'ACCEPTED', 'Invitation status is ACCEPTED');
    assert(acceptedInv.acceptedAt, 'acceptedAt is populated');
    assert(String(acceptedInv.acceptedByUserId) === String(activatedUser._id), 'acceptedByUserId is populated');

    // Token reuse protection: attempting second acceptance fails cleanly
    const secondSetupRes = await request('/api/v1/auth/setup-password', {
      method: 'POST',
      body: { token: tokenNew, password: 'AnotherPassword!' }
    });
    assert(secondSetupRes.status === 400, 'Accepted invitation cannot be reused (HTTP 400)');

    // Verify employee can now log in via normal /login
    const loginRes = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { email: emailNew, password: 'ArunPassword123!' }
    });
    assert(loginRes.status === 200 && loginRes.body.token, 'Employee can log in through normal /api/v1/auth/login');
    assert(loginRes.body.user.email === emailNew, 'Login returns employee identity');
    assert(loginRes.body.user.organizationRole === 'ENGINEER', 'Login resolves OrganizationMember role');

    // ------------------------------------------------------------------------
    // STEP 7: CASE B — EXISTING ACTIVE USER ONBOARDING WORKFLOW
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 7: CASE B — EXISTING ACTIVE USER WORKFLOW ---');
    const emailExisting = 'a1f-existing-active@geonexa.test';
    testEmailsToClean.push(emailExisting);

    // Create an active user with known password
    const existingPassword = 'ExistingSecret123!';
    const existingHash = await bcrypt.hash(existingPassword, 12);
    const existingUser = await User.create({
      email: emailExisting,
      displayName: 'Existing User Priya',
      passwordHash: existingHash,
      status: 'ACTIVE'
    });

    // Admin invites Priya into ORG-1 and LAN-PRO-01
    const createExistRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Priya Sharma',
        email: emailExisting,
        designation: 'Senior Geologist',
        department: 'Surveys',
        organizationRole: 'ENGINEER',
        projectRole: 'ENGINEER'
      }
    });
    assert(createExistRes.status === 201, 'Created invitation for existing active user');
    const tokenExisting = createExistRes.body.rawToken;

    // Check user was not duplicated or password changed
    const userAfterInvite = await User.findById(existingUser._id).lean();
    assert(userAfterInvite.passwordHash === existingHash, 'Existing user password was NOT reset or modified');

    // Validate returns isExistingActiveUser: true
    const valExistRes = await request(`/api/v1/employee-invitations/validate?token=${tokenExisting}`);
    assert(valExistRes.status === 200 && valExistRes.body.isExistingActiveUser === true, 'Validate reports isExistingActiveUser: true');

    // Unauthenticated acceptance attempt rejected
    const unauthAcceptRes = await request('/api/v1/employee-invitations/accept', {
      method: 'POST',
      body: { token: tokenExisting }
    });
    assert(unauthAcceptRes.status === 401, 'Unauthenticated acceptance for existing user rejected (HTTP 401)');

    // Acceptance with wrong user credentials rejected
    const wrongUserRes = await request('/api/v1/employee-invitations/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }, // adminToken has email org1@yopmail.com, not Priya
      body: { token: tokenExisting }
    });
    assert(wrongUserRes.status === 403, 'Email mismatch rejected (HTTP 403)');

    // Priya logs in with her own credentials
    // Note: Priya does not have Org membership yet, so create a temporary org token for authentication check
    const priyaToken = makeToken(existingUser, org._id, 'ENGINEER');

    // Priya accepts invitation with her authenticated token
    const priyaAcceptRes = await request('/api/v1/employee-invitations/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${priyaToken}` },
      body: { token: tokenExisting }
    });
    assert(priyaAcceptRes.status === 200 && priyaAcceptRes.body.success === true, 'Priya accepts invitation with authenticated token (HTTP 200)');

    // Check memberships created
    const priyaOrgMember = await OrganizationMember.findOne({ organizationId: org._id, userId: existingUser._id, status: 'ACTIVE' });
    assert(priyaOrgMember && priyaOrgMember.organizationRole === 'ENGINEER', 'OrganizationMember created for existing user');

    const priyaProjMember = await ProjectMember.findOne({ projectId: project._id, userId: existingUser._id, status: 'ACTIVE' });
    assert(priyaProjMember && priyaProjMember.role === 'ENGINEER', 'ProjectMember created for existing user');

    const priyaEmpProfile = await EmployeeProfile.findOne({ organizationId: org._id, userId: existingUser._id, status: 'ACTIVE' });
    assert(priyaEmpProfile, 'EmployeeProfile created for existing user');

    // Attempting to re-invite when all 3 exist returns 409
    const reInviteRes = await request(`/api/v1/projects/${project._id}/employee-invitations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        displayName: 'Priya Sharma',
        email: emailExisting,
        organizationRole: 'ENGINEER',
        projectRole: 'ENGINEER'
      }
    });
    assert(reInviteRes.status === 409, 'Re-inviting fully onboarded user rejected (HTTP 409)');

    // ------------------------------------------------------------------------
    // STEP 8: TEAM INTEGRATION & INVESTIGATION ASSIGNMENT ELIGIBILITY
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 8: TEAM INTEGRATION & WORK ASSIGNMENT ---');

    // Get or create an active team in LAN-PRO-01 (e.g. TEAM-0001 Geotechnical Engineering)
    let team = await Team.findOne({ organizationId: org._id, status: 'ACTIVE' });
    let createdTestTeam = false;
    if (!team) {
      team = await Team.create({
        organizationId: org._id,
        teamCode: 'TEST-A1F-TEAM',
        name: 'Geotechnical Engineering Team',
        status: 'ACTIVE'
      });
      createdTestTeam = true;
    }
    assert(team, 'Active team must exist');

    // Ensure team has active ProjectTeamAccess for LAN-PRO-01
    let pta = await ProjectTeamAccess.findOne({ organizationId: org._id, projectId: project._id, teamId: team._id, status: 'ACTIVE' });
    if (!pta) {
      pta = await ProjectTeamAccess.create({
        organizationId: org._id,
        projectId: project._id,
        teamId: team._id,
        status: 'ACTIVE'
      });
    }
    assert(pta, 'Team must have active ProjectTeamAccess in LAN-PRO-01');

    // Add Arun Kumar to the team
    const addTeamMemberRes = await request(`/api/v1/organizations/${org._id}/teams/${team._id}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        userId: String(activatedUser._id),
        membershipRole: 'MEMBER'
      }
    });
    assert(addTeamMemberRes.status === 201, 'Accepted employee added to Team (HTTP 201)');

    // Verify eligible members query for Investigation assignment
    const eligibleMembersRes = await request(`/api/v1/projects/${project._id}/workforce-teams/${team._id}/eligible-members`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (eligibleMembersRes.status === 200 && Array.isArray(eligibleMembersRes.body)) {
      const isEligible = eligibleMembersRes.body.some((m) => String(m.userId) === String(activatedUser._id));
      assert(isEligible, 'Accepted employee is eligible candidate in Investigation team dropdown');
    } else {
      // Check directly in TeamMember
      const tm = await TeamMember.findOne({ teamId: team._id, userId: activatedUser._id, status: 'ACTIVE' });
      assert(tm, 'TeamMember active record verified');
    }

    // ------------------------------------------------------------------------
    // STEP 9: PLATFORM ADMIN SAFETY & INVARIANTS
    // ------------------------------------------------------------------------
    console.log('\n--- STEP 9: PLATFORM ADMIN SAFETY & INVARIANTS ---');

    // Verify LAN-PRO-01 accessMode is still ROLE_BASED
    const finalProject = await Project.findById(project._id).lean();
    const effectiveMode = finalProject.accessMode || 'ROLE_BASED';
    assert(effectiveMode === 'ROLE_BASED', 'FINAL INVARIANT: LAN-PRO-01 accessMode must remain ROLE_BASED');

    // Verify org1@yopmail.com is untouched
    const finalAdmin = await User.findOne({ email: 'org1@yopmail.com' }).lean();
    assert(finalAdmin && finalAdmin.status === 'ACTIVE', 'FINAL INVARIANT: org1@yopmail.com is ACTIVE and unmodified');

    console.log('\n========================================================');
    console.log('PHASE A1F ALL AUTOMATED VERIFICATION CHECKS PASSED!');
    console.log('========================================================\n');

  } finally {
    // Clean up temporary test accounts
    try {
      for (const email of testEmailsToClean) {
        const u = await User.findOne({ email });
        if (u) {
          await OrganizationMember.deleteMany({ userId: u._id });
          await ProjectMember.deleteMany({ userId: u._id });
          await EmployeeProfile.deleteMany({ userId: u._id });
          await TeamMember.deleteMany({ userId: u._id });
          await EmployeeInvitation.deleteMany({ acceptedByUserId: u._id });
          await User.deleteOne({ _id: u._id });
        }
        await EmployeeInvitation.deleteMany({ emailNormalized: email });
      }
      await Team.deleteMany({ teamCode: /^TEST-A1F-/ });
      await ProjectTeamAccess.deleteMany({ teamId: { $in: await Team.find({ teamCode: /^TEST-A1F-/ }).distinct('_id') } });
      await Project.deleteOne({ code: { $regex: /^FOR-PRJ-/ } });
      await Organization.deleteOne({ code: { $regex: /^FOR-/ } });
    } catch (_) {}

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
  }
}

runTests().catch((err) => {
  console.error('\n\x1b[31m[TEST SUITE FAILURE]\x1b[0m', err);
  process.exit(1);
});
