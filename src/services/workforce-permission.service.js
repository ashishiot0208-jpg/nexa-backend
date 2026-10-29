import { OrganizationMember, ProjectMember, Team, TeamMember, ProjectTeamAccess, Project, User, EmployeeProfile } from '../models/index.js';

/**
 * Effective Team Permission Resolver
 * Phase A1A: Resolves effective permissions granted to a user on a project via team assignments.
 * 
 * Rules:
 * 1. Find user's ACTIVE TeamMember records in organization.
 * 2. Find ACTIVE Teams for those memberships (inactive teams are excluded).
 * 3. Find ACTIVE ProjectTeamAccess records for those Teams and Project (inactive access records are excluded).
 * 4. Merge and deduplicate permission keys.
 * 5. Check if user is an Administrator (organization or project level).
 * 
 * Note: Does NOT replace req.projectRole enforcement in A1A.
 */
export async function getUserProjectTeamPermissions({ organizationId, projectId, userId }) {
  if (!organizationId || !projectId || !userId) {
    return {
      organizationId,
      projectId,
      userId,
      isAdministrator: false,
      teams: [],
      permissions: []
    };
  }

  // 1. Check Administrator status in Organization or Project
  const [orgMember, projMember] = await Promise.all([
    OrganizationMember.findOne({ organizationId, userId, status: 'ACTIVE' }).select('organizationRole').lean(),
    ProjectMember.findOne({ projectId, userId, status: 'ACTIVE' }).select('role').lean()
  ]);

  const isAdministrator = orgMember?.organizationRole === 'ADMINISTRATOR' || projMember?.role === 'ADMINISTRATOR';

  // 2. Find ACTIVE TeamMember records for this user in this organization
  const activeMemberships = await TeamMember.find({
    organizationId,
    userId,
    status: 'ACTIVE'
  }).lean();

  if (!activeMemberships || activeMemberships.length === 0) {
    return {
      organizationId: organizationId.toString(),
      projectId: projectId.toString(),
      userId: userId.toString(),
      isAdministrator,
      teams: [],
      permissions: []
    };
  }

  const membershipRoleMap = new Map(
    activeMemberships.map((m) => [m.teamId.toString(), m.membershipRole])
  );
  const teamIds = activeMemberships.map((m) => m.teamId);

  // 3. Find ACTIVE Teams (inactive teams must be excluded)
  const activeTeams = await Team.find({
    _id: { $in: teamIds },
    organizationId,
    status: 'ACTIVE'
  }).lean();

  if (!activeTeams || activeTeams.length === 0) {
    return {
      organizationId: organizationId.toString(),
      projectId: projectId.toString(),
      userId: userId.toString(),
      isAdministrator,
      teams: [],
      permissions: []
    };
  }

  const activeTeamIds = activeTeams.map((t) => t._id);

  // 4. Find ACTIVE ProjectTeamAccess records for those teams on this project
  const activeAccessList = await ProjectTeamAccess.find({
    organizationId,
    projectId,
    teamId: { $in: activeTeamIds },
    status: 'ACTIVE'
  }).lean();

  const accessTeamIds = new Set(activeAccessList.map((a) => a.teamId.toString()));

  // 5. Merge and deduplicate permission keys
  const permissionSet = new Set();
  for (const access of activeAccessList) {
    if (Array.isArray(access.permissions)) {
      for (const perm of access.permissions) {
        if (typeof perm === 'string' && perm.trim()) {
          permissionSet.add(perm.trim());
        }
      }
    }
  }

  // Build compact team details for assigned teams that have access
  const teamsOutput = activeTeams
    .filter((t) => accessTeamIds.has(t._id.toString()))
    .map((t) => {
      const accessRec = activeAccessList.find((a) => a.teamId.toString() === t._id.toString());
      return {
        teamId: t._id,
        teamCode: t.teamCode,
        name: t.name,
        membershipRole: membershipRoleMap.get(t._id.toString()) || 'MEMBER',
        accessProfile: accessRec?.accessProfile || null,
        permissions: accessRec?.permissions || []
      };
    });

  return {
    organizationId: organizationId.toString(),
    projectId: projectId.toString(),
    userId: userId.toString(),
    isAdministrator,
    teams: teamsOutput,
    permissions: Array.from(permissionSet).sort()
  };
}

/**
 * Project Access Mode Activation Readiness Validator (Phase A1D)
 *
 * Verifies whether all active non-admin ProjectMembers of a project
 * have active team memberships and active ProjectTeamAccess granting permissions.
 * Blocks activation if any active non-admin member would be left with zero permissions.
 */
export async function calculateProjectAccessReadiness({ organizationId, projectId }) {
  if (!organizationId || !projectId) {
    throw new Error('organizationId and projectId are required');
  }

  const project = await Project.findOne({ _id: projectId, organizationId }).lean();
  if (!project) throw new Error('Project not found in this organization');

  // Find all active project members
  const projectMembers = await ProjectMember.find({ projectId, status: 'ACTIVE' }).lean();

  const membersReport = [];
  const uncoveredUsers = [];
  let totalNonAdminMembers = 0;
  let coveredMembers = 0;
  let uncoveredMembers = 0;

  for (const pm of projectMembers) {
    const userId = pm.userId;
    // Check if user is an Administrator
    const orgMember = await OrganizationMember.findOne({ organizationId, userId, status: 'ACTIVE' }).select('organizationRole').lean();
    const isAdministrator = orgMember?.organizationRole === 'ADMINISTRATOR' || pm.role === 'ADMINISTRATOR';

    const [user, employeeProfile] = await Promise.all([
      User.findById(userId).select('email displayName').lean(),
      EmployeeProfile.findOne({ organizationId, userId, status: 'ACTIVE' }).select('employeeCode designation department').lean()
    ]);

    const displayName = employeeProfile?.displayName || user?.displayName || 'Unknown';
    const email = user?.email || '';
    const employeeCode = employeeProfile?.employeeCode || '';
    const designation = employeeProfile?.designation || '';

    if (isAdministrator) {
      membersReport.push({
        userId: userId.toString(),
        displayName,
        email,
        employeeCode,
        designation,
        projectRole: pm.role,
        isAdministrator: true,
        hasActiveTeam: true,
        hasActiveProjectTeamAccess: true,
        effectivePermissionsCount: 35,
        isCovered: true
      });
      continue;
    }

    // Non-admin member: evaluate team permissions
    totalNonAdminMembers++;
    const teamPerms = await getUserProjectTeamPermissions({
      organizationId,
      projectId,
      userId
    });

    const hasActiveTeam = teamPerms.teams && teamPerms.teams.length > 0;
    const hasActiveProjectTeamAccess = hasActiveTeam && teamPerms.teams.some((t) => t.permissions && t.permissions.length > 0);
    const effectivePermissionsCount = (teamPerms.permissions || []).length;
    const isCovered = effectivePermissionsCount > 0;

    const memberData = {
      userId: userId.toString(),
      displayName,
      email,
      employeeCode,
      designation,
      projectRole: pm.role,
      isAdministrator: false,
      hasActiveTeam,
      hasActiveProjectTeamAccess,
      effectivePermissionsCount,
      isCovered,
      teams: teamPerms.teams || []
    };

    membersReport.push(memberData);

    if (isCovered) {
      coveredMembers++;
    } else {
      uncoveredMembers++;
      let reason = 'User is not assigned to any active Team with active Project Team Access';
      if (!hasActiveTeam) {
        reason = 'User is not assigned to any active Team';
      } else if (!hasActiveProjectTeamAccess) {
        reason = 'User belongs to Team(s), but none have active Project Team Access';
      } else {
        reason = 'User team access profile grants zero effective permissions';
      }
      uncoveredUsers.push({
        ...memberData,
        reason
      });
    }
  }

  const isReady = uncoveredMembers === 0;

  return {
    projectId: projectId.toString(),
    accessMode: project.accessMode || 'ROLE_BASED',
    isReady,
    totalProjectMembers: projectMembers.length,
    totalNonAdminMembers,
    coveredMembers,
    uncoveredMembers,
    uncoveredUserIds: uncoveredUsers.map((u) => u.userId),
    uncoveredUsers,
    members: membersReport
  };
}
