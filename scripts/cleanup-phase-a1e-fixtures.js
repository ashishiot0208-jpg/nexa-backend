#!/usr/bin/env node

/**
 * CLEANUP PHASE A1E TEST FIXTURES
 *
 * Safely discovers and removes leaked Phase A1E test fixtures from MongoDB:
 * - Teams: teamCode starting with 'TEST-A1E-'
 * - Employee Profiles: EMP-0017 and EMP-0018 (with safety verification of linked user)
 * - Temporary A1E Users: exact email list
 * - Projects: code starting with 'TEST-A1E-'
 * - Investigations: title starting with 'A1E-TEST-' OR investigationCode starting with 'A1E-INV-'
 *
 * Dependent records are resolved and deleted first:
 * - InvestigationEvent
 * - TeamMember
 * - ProjectTeamAccess
 * - ProjectMember (for TEST-A1E- projects only)
 * - OrganizationMember (for exact temporary A1E users only)
 *
 * Safety Invariants:
 * - NEVER deletes legitimate teams: TEAM-0001, TEAM-0002
 * - NEVER deletes legitimate employee profiles: EMP-0001, EMP-0002
 * - NEVER deletes legitimate projects: LAN-PRO-01, etc.
 * - NEVER deletes underlying real/permanent users: engineer@geonexa.test, operator@geonexa.test, admin@geonexa.test, viewer@geonexa.test, etc.
 * - Fails and aborts if EMP-0017 or EMP-0018 points to unexpected user.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import {
  Project,
  User,
  OrganizationMember,
  ProjectMember,
  Investigation,
  InvestigationEvent,
  EmployeeProfile,
  Team,
  TeamMember,
  ProjectTeamAccess
} from '../src/models/index.js';

// Exact temporary user emails created by A1E
export const A1E_TEMP_USER_EMAILS = [
  'a1e-inact-mem@geonexa.test',
  'a1e-inact-org@geonexa.test',
  'a1e-nonproj@geonexa.test',
  'a1e-user-a@geonexa.test',
  'a1e-user-b@geonexa.test',
  'a1e-outsider@geonexa.test'
];

// Exact test employee codes and their required linked user emails for safety
export const A1E_TEMP_EMPLOYEE_SPECS = {
  'EMP-0017': { expectedEmail: 'engineer@geonexa.test', expectedName: 'Rahul Das' },
  'EMP-0018': { expectedEmail: 'operator@geonexa.test', expectedName: 'Ananya Sen' }
};

// Protected legitimate identifiers that must NEVER be deleted
export const PROTECTED_IDENTIFIERS = {
  teams: ['TEAM-0001', 'TEAM-0002'],
  employeeCodes: ['EMP-0001', 'EMP-0002'],
  projects: ['LAN-PRO-01', 'NH-10', 'TN-01', 'DM-01', 'PRJ-TUN-02', 'LAN-SEC-TEST'],
  users: [
    'admin@geonexa.test',
    'engineer@geonexa.test',
    'operator@geonexa.test',
    'viewer@geonexa.test',
    'org1@yopmail.com',
    'emp1@yopmail.com'
  ]
};

/**
 * Reusable cleanup function for A1E fixtures.
 * Discovers records dynamically from the database.
 * Does not depend on test suite local variables.
 */
export async function cleanupA1EFixtures(options = {}) {
  const { verbose = false } = options;
  const log = (msg) => { if (verbose) console.log(msg); };

  log('[CLEANUP-A1E] Scanning for Phase A1E test fixtures...');

  // 1. Discover Teams with code starting with TEST-A1E-
  const candidateTeams = await Team.find({ teamCode: /^TEST-A1E-/ }).lean();
  const testTeams = candidateTeams.filter(t => {
    if (PROTECTED_IDENTIFIERS.teams.includes(t.teamCode)) {
      throw new Error(`[SAFETY VIOLATION] Protected team ${t.teamCode} matched test regex! Aborting.`);
    }
    return t.teamCode && t.teamCode.startsWith('TEST-A1E-');
  });
  const testTeamIds = testTeams.map(t => t._id);

  // 2. Discover Projects with code starting with TEST-A1E-
  const candidateProjects = await Project.find({ code: /^TEST-A1E-/ }).lean();
  const testProjects = candidateProjects.filter(p => {
    if (PROTECTED_IDENTIFIERS.projects.includes(p.code)) {
      throw new Error(`[SAFETY VIOLATION] Protected project ${p.code} matched test regex! Aborting.`);
    }
    return p.code && p.code.startsWith('TEST-A1E-');
  });
  const testProjectIds = testProjects.map(p => p._id);

  // 3. Discover Investigations matching A1E identifiers
  const candidateInvs = await Investigation.find({
    $or: [
      { title: /^A1E-TEST-/ },
      { investigationCode: /^A1E-INV-/ }
    ]
  }).lean();
  const testInvs = candidateInvs.filter(i => {
    const isA1E = (i.title && i.title.startsWith('A1E-TEST-')) ||
                  (i.investigationCode && i.investigationCode.startsWith('A1E-INV-'));
    return isA1E;
  });
  const testInvIds = testInvs.map(i => i._id);

  // 4. Discover Temporary Users
  const testUsers = await User.find({ email: { $in: A1E_TEMP_USER_EMAILS } }).lean();
  const testUserIds = testUsers.map(u => u._id);

  // 5. Discover and Validate Test Employee Profiles
  const candidateProfiles = await EmployeeProfile.find({
    employeeCode: { $in: Object.keys(A1E_TEMP_EMPLOYEE_SPECS) }
  }).populate('userId', 'email displayName').lean();

  const validatedProfileIds = [];
  const validatedProfileCodes = [];

  for (const prof of candidateProfiles) {
    if (PROTECTED_IDENTIFIERS.employeeCodes.includes(prof.employeeCode)) {
      throw new Error(`[SAFETY VIOLATION] Protected employee ${prof.employeeCode} matched! Aborting.`);
    }

    const spec = A1E_TEMP_EMPLOYEE_SPECS[prof.employeeCode];
    if (!spec) {
      throw new Error(`[SAFETY VIOLATION] Unrecognized employee profile code ${prof.employeeCode}! Aborting.`);
    }

    const linkedEmail = prof.userId?.email;
    if (linkedEmail !== spec.expectedEmail) {
      throw new Error(
        `[SAFETY VIOLATION] ${prof.employeeCode} (${prof.displayName}) is linked to user email "${linkedEmail}", expected "${spec.expectedEmail}". Aborting to prevent accidental data loss.`
      );
    }

    validatedProfileIds.push(prof._id);
    validatedProfileCodes.push(prof.employeeCode);
  }

  // Log discovery summary if verbose
  if (verbose) {
    console.log(`[CLEANUP-A1E] Found ${testTeams.length} test teams:`, testTeams.map(t => `${t.teamCode} (${t.name})`));
    console.log(`[CLEANUP-A1E] Found ${testProjects.length} test projects:`, testProjects.map(p => p.code));
    console.log(`[CLEANUP-A1E] Found ${testInvs.length} test investigations:`, testInvs.map(i => `${i.investigationCode} (${i.title})`));
    console.log(`[CLEANUP-A1E] Found ${testUsers.length} temporary users:`, testUsers.map(u => u.email));
    console.log(`[CLEANUP-A1E] Found ${validatedProfileCodes.length} validated test employee profiles:`, validatedProfileCodes);
  }

  // --- DEPENDENCY CLEANUP FIRST ---
  // 6. Delete InvestigationEvents for test investigations
  let deletedInvEvents = 0;
  if (testInvIds.length > 0) {
    const res = await InvestigationEvent.deleteMany({ investigationId: { $in: testInvIds } });
    deletedInvEvents = res.deletedCount || 0;
  }

  // 7. Delete TeamMembers for test teams OR test users
  let deletedTeamMembers = 0;
  const teamMemberQueries = [];
  if (testTeamIds.length > 0) teamMemberQueries.push({ teamId: { $in: testTeamIds } });
  if (testUserIds.length > 0) teamMemberQueries.push({ userId: { $in: testUserIds } });
  if (teamMemberQueries.length > 0) {
    const res = await TeamMember.deleteMany({ $or: teamMemberQueries });
    deletedTeamMembers = res.deletedCount || 0;
  }

  // 8. Delete ProjectTeamAccess for test teams OR test projects
  let deletedProjectTeamAccess = 0;
  const teamAccessQueries = [];
  if (testTeamIds.length > 0) teamAccessQueries.push({ teamId: { $in: testTeamIds } });
  if (testProjectIds.length > 0) teamAccessQueries.push({ projectId: { $in: testProjectIds } });
  if (teamAccessQueries.length > 0) {
    const res = await ProjectTeamAccess.deleteMany({ $or: teamAccessQueries });
    deletedProjectTeamAccess = res.deletedCount || 0;
  }

  // 9. Delete ProjectMember for TEST-A1E projects only (NEVER for LAN-PRO-01)
  let deletedProjectMembers = 0;
  if (testProjectIds.length > 0) {
    const res = await ProjectMember.deleteMany({ projectId: { $in: testProjectIds } });
    deletedProjectMembers = res.deletedCount || 0;
  }

  // 10. Delete OrganizationMember for exact temporary A1E users only
  let deletedOrgMembers = 0;
  if (testUserIds.length > 0) {
    const res = await OrganizationMember.deleteMany({ userId: { $in: testUserIds } });
    deletedOrgMembers = res.deletedCount || 0;
  }

  // --- DELETE PRIMARY TEST ENTITIES ---
  // 11. Delete test investigations
  let deletedInvs = 0;
  if (testInvIds.length > 0) {
    const res = await Investigation.deleteMany({ _id: { $in: testInvIds } });
    deletedInvs = res.deletedCount || 0;
  }

  // 12. Delete test teams
  let deletedTeams = 0;
  if (testTeamIds.length > 0) {
    const res = await Team.deleteMany({ _id: { $in: testTeamIds } });
    deletedTeams = res.deletedCount || 0;
  }

  // 13. Delete test projects
  let deletedProjects = 0;
  if (testProjectIds.length > 0) {
    const res = await Project.deleteMany({ _id: { $in: testProjectIds } });
    deletedProjects = res.deletedCount || 0;
  }

  // 14. Delete temporary users (never touches engineer@, operator@, etc.)
  let deletedUsers = 0;
  if (testUserIds.length > 0) {
    const res = await User.deleteMany({ _id: { $in: testUserIds } });
    deletedUsers = res.deletedCount || 0;
  }

  // 15. Delete test employee profiles (only EMP-0017 & EMP-0018 validated above)
  let deletedEmployeeProfiles = 0;
  if (validatedProfileIds.length > 0) {
    const res = await EmployeeProfile.deleteMany({ _id: { $in: validatedProfileIds } });
    deletedEmployeeProfiles = res.deletedCount || 0;
  }

  const summary = {
    testTeamsMatched: testTeams.length,
    teamsDeleted: deletedTeams,
    teamMembersDeleted: deletedTeamMembers,
    projectTeamAccessDeleted: deletedProjectTeamAccess,
    testProjectsMatched: testProjects.length,
    projectsDeleted: deletedProjects,
    projectMembersDeleted: deletedProjectMembers,
    testInvsMatched: testInvs.length,
    investigationsDeleted: deletedInvs,
    investigationEventsDeleted: deletedInvEvents,
    tempUsersMatched: testUsers.length,
    usersDeleted: deletedUsers,
    organizationMembersDeleted: deletedOrgMembers,
    employeeProfilesMatched: validatedProfileCodes.length,
    employeeProfilesDeleted: deletedEmployeeProfiles
  };

  if (verbose) {
    console.log('[CLEANUP-A1E] Cleanup completed:', summary);
  }

  return summary;
}

/**
 * Standalone executor for safe one-time or manual cleanup.
 */
export async function runStandalone() {
  console.log('========================================================');
  console.log('PHASE A1E — SAFE TEST FIXTURE CLEANUP SCRIPT');
  console.log('========================================================\n');

  const mongoUri = env.mongoUri || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
  console.log('Connecting to MongoDB:', mongoUri);
  await mongoose.connect(mongoUri);

  try {
    // 1. Pre-cleanup inspection
    console.log('\n--- PRE-CLEANUP INSPECTION ---');
    const existingTeams = await Team.find({ teamCode: /^TEST-A1E-/ }).lean();
    console.log(`Matched Test Teams (${existingTeams.length}):`, existingTeams.map(t => `${t.teamCode} (${t.name})`));

    const existingProfiles = await EmployeeProfile.find({
      employeeCode: { $in: ['EMP-0017', 'EMP-0018'] }
    }).populate('userId', 'email displayName').lean();
    console.log(
      `Matched Test Employee Profiles (${existingProfiles.length}):`,
      existingProfiles.map(e => `${e.employeeCode} (${e.displayName}) -> user: ${e.userId?.email}`)
    );

    const existingUsers = await User.find({ email: { $in: A1E_TEMP_USER_EMAILS } }).lean();
    console.log(`Matched Temporary Users (${existingUsers.length}):`, existingUsers.map(u => u.email));

    const existingProjects = await Project.find({ code: /^TEST-A1E-/ }).lean();
    console.log(`Matched Test Projects (${existingProjects.length}):`, existingProjects.map(p => p.code));

    const existingInvs = await Investigation.find({
      $or: [{ title: /^A1E-TEST-/ }, { investigationCode: /^A1E-INV-/ }]
    }).lean();
    console.log(`Matched Test Investigations (${existingInvs.length}):`, existingInvs.map(i => `${i.investigationCode} (${i.title})`));

    // 2. Execute cleanup
    console.log('\n--- EXECUTING SAFE CLEANUP ---');
    const summary = await cleanupA1EFixtures({ verbose: true });

    // 3. Post-cleanup verification
    console.log('\n--- POST-CLEANUP VERIFICATION ---');
    const remainingTeams = await Team.find({ teamCode: /^TEST-A1E-/ }).lean();
    const remainingProfiles = await EmployeeProfile.find({ employeeCode: { $in: ['EMP-0017', 'EMP-0018'] } }).lean();
    const remainingUsers = await User.find({ email: { $in: A1E_TEMP_USER_EMAILS } }).lean();
    const remainingProjects = await Project.find({ code: /^TEST-A1E-/ }).lean();
    const remainingInvs = await Investigation.find({
      $or: [{ title: /^A1E-TEST-/ }, { investigationCode: /^A1E-INV-/ }]
    }).lean();

    console.log(`Remaining TEST-A1E Teams: ${remainingTeams.length} (expected 0)`);
    console.log(`Remaining EMP-0017/EMP-0018 Profiles: ${remainingProfiles.length} (expected 0)`);
    console.log(`Remaining Temporary A1E Users: ${remainingUsers.length} (expected 0)`);
    console.log(`Remaining TEST-A1E Projects: ${remainingProjects.length} (expected 0)`);
    console.log(`Remaining A1E Investigations: ${remainingInvs.length} (expected 0)`);

    if (
      remainingTeams.length > 0 ||
      remainingProfiles.length > 0 ||
      remainingUsers.length > 0 ||
      remainingProjects.length > 0 ||
      remainingInvs.length > 0
    ) {
      throw new Error('[POST-CLEANUP VERIFICATION FAILED] Stale test fixtures still exist in database!');
    }

    // 4. Verify Legitimate Records & Invariants
    console.log('\n--- VERIFYING LEGITIMATE SYSTEM RECORDS ---');
    const legitTeams = await Team.find({ teamCode: { $in: ['TEAM-0001', 'TEAM-0002'] } }).lean();
    console.log(`Legitimate Teams intact (${legitTeams.length}):`, legitTeams.map(t => `${t.teamCode}: ${t.name}`));
    if (legitTeams.length !== 2) {
      throw new Error(`[CRITICAL] Legitimate teams missing! Expected 2, found ${legitTeams.length}`);
    }

    const legitProfiles = await EmployeeProfile.find({ employeeCode: { $in: ['EMP-0001', 'EMP-0002'] } }).lean();
    console.log(`Legitimate Employee Profiles intact (${legitProfiles.length}):`, legitProfiles.map(e => `${e.employeeCode}: ${e.displayName}`));
    if (legitProfiles.length !== 2) {
      throw new Error(`[CRITICAL] Legitimate employee profiles missing! Expected 2, found ${legitProfiles.length}`);
    }

    const lanProject = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
    if (!lanProject) {
      throw new Error('[CRITICAL] LAN-PRO-01 project not found!');
    }
    console.log(`LAN-PRO-01 verified: accessMode is "${lanProject.accessMode || 'ROLE_BASED'}" (remains ROLE_BASED)`);

    // Verify underlying user accounts engineer@ and operator@ were NOT deleted
    const engineerUser = await User.findOne({ email: 'engineer@geonexa.test' }).lean();
    const operatorUser = await User.findOne({ email: 'operator@geonexa.test' }).lean();
    if (!engineerUser || !operatorUser) {
      throw new Error('[CRITICAL] engineer@geonexa.test or operator@geonexa.test user account was deleted!');
    }
    console.log('Confirmed engineer@geonexa.test and operator@geonexa.test user accounts preserved intact.');

    console.log('\n========================================================');
    console.log('CLEANUP SUCCESSFUL: All leaked A1E fixtures safely removed!');
    console.log('========================================================\n');
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

// Auto-run if executed directly via CLI
const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === executedFilePath) {
  runStandalone().catch(err => {
    console.error('\n\x1b[31m[CLEANUP FAILED]\x1b[0m', err);
    process.exit(1);
  });
}

