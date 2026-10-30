import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import {
  EmployeeProfile,
  Team,
  TeamMember,
  ProjectTeamAccess,
  OrganizationMember,
  ProjectMember,
  Project,
  User,
  EmployeeInvitation
} from '../models/index.js';
import { env } from '../config/env.js';
import { requireAuth, requireProjectAccess, requireProjectPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from '../services/audit.service.js';
import {
  PERMISSION_GROUPS,
  ALL_PERMISSIONS,
  ACCESS_PROFILES,
  validatePermissions
} from '../config/permissions.js';
import { getUserProjectTeamPermissions, calculateProjectAccessReadiness } from '../services/workforce-permission.service.js';
import {
  createEmployeeInvitation,
  listEmployeeInvitations,
  getEmployeeInvitation,
  regenerateEmployeeInvitation,
  revokeEmployeeInvitation,
  validateInvitationToken,
  acceptEmployeeInvitation
} from '../services/employee-invitation.service.js';

const router = Router();

// ============================================================================
// PUBLIC / ONBOARDING EMPLOYEE INVITATION ENDPOINTS (Phase A1F)
// ============================================================================

router.get('/employee-invitations/validate', asyncHandler(async (req, res) => {
  const token = req.query.token;
  if (!token) throw new ApiError(400, 'Invitation token is required');
  const result = await validateInvitationToken(token);
  res.json(result);
}));

router.post('/employee-invitations/accept', asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token) throw new ApiError(400, 'Invitation token is required');

  let authUser = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwtToken = authHeader.slice(7);
      const payload = jwt.verify(jwtToken, env.jwtSecret);
      const u = await User.findById(payload.sub).lean();
      if (u && u.status === 'ACTIVE') {
        authUser = {
          userId: u._id.toString(),
          email: u.email,
          displayName: u.displayName,
          organizationId: payload.organizationId,
          organizationRole: payload.organizationRole
        };
      }
    } catch (_) {}
  }

  const result = await acceptEmployeeInvitation({
    rawToken: token,
    password,
    authUser
  });

  await audit({
    req,
    organizationId: result.organizationId,
    projectId: result.projectId,
    action: 'EMPLOYEE_INVITATION_ACCEPTED',
    resourceType: 'EmployeeInvitation',
    newState: { email: result.email }
  });

  res.json(result);
}));

router.use(requireAuth);


// ============================================================================
// HELPER GUARDS & VALIDATIONS
// ============================================================================

function assertOrgIsolation(req, targetOrgId) {
  const userOrgId = req.auth?.organizationId?.toString();
  const orgId = targetOrgId?.toString();
  if (!userOrgId || !orgId || userOrgId !== orgId) {
    throw new ApiError(403, 'Forbidden: Organization access mismatch');
  }
}

function requireAdmin(req) {
  if (req.auth?.organizationRole !== 'ADMINISTRATOR') {
    throw new ApiError(403, 'Administrator access required');
  }
}

async function getVerifiedProject(projectId, userOrgId) {
  if (!projectId) throw new ApiError(400, 'Project ID is required');
  const project = await Project.findOne({ _id: projectId, organizationId: userOrgId }).lean();
  if (!project) throw new ApiError(404, 'Project not found in this organization');
  return project;
}

async function generateNextTeamCode(organizationId) {
  const teams = await Team.find({
    organizationId,
    teamCode: { $regex: /^TEAM-\d+$/ }
  }).select('teamCode').lean();

  let maxNum = 0;
  for (const t of teams) {
    const num = parseInt(t.teamCode.replace('TEAM-', ''), 10);
    if (!isNaN(num) && num > maxNum) maxNum = num;
  }
  let nextNum = maxNum + 1;
  while (true) {
    const candidate = `TEAM-${String(nextNum).padStart(4, '0')}`;
    const exists = await Team.exists({ organizationId, teamCode: candidate });
    if (!exists) return candidate;
    nextNum++;
  }
}

async function generateNextEmployeeCode(organizationId) {
  const employees = await EmployeeProfile.find({
    organizationId,
    employeeCode: { $regex: /^EMP-\d+$/ }
  }).select('employeeCode').lean();

  let maxNum = 0;
  for (const e of employees) {
    const num = parseInt(e.employeeCode.replace('EMP-', ''), 10);
    if (!isNaN(num) && num > maxNum) maxNum = num;
  }
  let nextNum = maxNum + 1;
  while (true) {
    const candidate = `EMP-${String(nextNum).padStart(4, '0')}`;
    const exists = await EmployeeProfile.exists({ organizationId, employeeCode: candidate });
    if (!exists) return candidate;
    nextNum++;
  }
}

// ============================================================================
// 1. PERMISSION CATALOG & ACCESS PROFILES
// ============================================================================

router.get('/projects/:projectId/access-permissions', asyncHandler(async (req, res) => {
  await getVerifiedProject(req.params.projectId, req.auth.organizationId);
  res.json({
    groups: PERMISSION_GROUPS,
    permissions: ALL_PERMISSIONS,
    profiles: ACCESS_PROFILES
  });
}));

router.get('/organizations/:organizationId/access-permissions', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  res.json({
    groups: PERMISSION_GROUPS,
    permissions: ALL_PERMISSIONS,
    profiles: ACCESS_PROFILES
  });
}));

router.get('/organizations/:organizationId/users', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  const members = await OrganizationMember.find({
    organizationId: req.auth.organizationId,
    status: 'ACTIVE'
  }).populate('userId', 'displayName email status').lean();

  const users = members
    .filter((m) => m.userId && m.userId.status === 'ACTIVE')
    .map((m) => ({
      userId: m.userId._id,
      email: m.userId.email,
      displayName: m.userId.displayName || m.userId.email,
      organizationRole: m.organizationRole
    }));
  res.json(users);
}));

// ============================================================================
// 2. EMPLOYEE PROFILES (WORKFORCE)
// ============================================================================

// GET all employees in organization
router.get('/organizations/:organizationId/employees', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  const profiles = await EmployeeProfile.find({ organizationId: req.auth.organizationId })
    .sort({ createdAt: -1 })
    .lean();

  const userIds = profiles.map((p) => p.userId);
  const primaryTeamIds = profiles.map((p) => p.primaryTeamId).filter(Boolean);

  const [users, orgMembers, teams] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('email displayName status').lean(),
    OrganizationMember.find({ organizationId: req.auth.organizationId, userId: { $in: userIds } }).lean(),
    Team.find({ organizationId: req.auth.organizationId, _id: { $in: primaryTeamIds } }).select('teamCode name').lean()
  ]);

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const orgMemberMap = new Map(orgMembers.map((m) => [m.userId.toString(), m]));
  const teamMap = new Map(teams.map((t) => [t._id.toString(), t]));

  const response = profiles.map((p) => {
    const user = userMap.get(p.userId.toString());
    const member = orgMemberMap.get(p.userId.toString());
    const primaryTeam = p.primaryTeamId ? teamMap.get(p.primaryTeamId.toString()) : null;

    return {
      id: p._id,
      _id: p._id,
      employeeCode: p.employeeCode,
      displayName: p.displayName,
      email: user?.email || '',
      phone: p.phone || '',
      designation: p.designation || '',
      department: p.department || '',
      status: p.status,
      userId: p.userId,
      userStatus: user?.status,
      organizationRole: member?.organizationRole || 'VIEWER',
      membershipStatus: member?.status || 'ACTIVE',
      primaryTeamId: p.primaryTeamId,
      primaryTeam: primaryTeam ? { id: primaryTeam._id, code: primaryTeam.teamCode, name: primaryTeam.name } : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    };
  });

  res.json(response);
}));

// GET single employee detail
router.get('/organizations/:organizationId/employees/:employeeId', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  const profile = await EmployeeProfile.findOne({
    _id: req.params.employeeId,
    organizationId: req.auth.organizationId
  }).lean();

  if (!profile) throw new ApiError(404, 'Employee profile not found');

  const [user, orgMember, teamMemberships] = await Promise.all([
    User.findById(profile.userId).select('email displayName status lastActiveAt').lean(),
    OrganizationMember.findOne({ organizationId: req.auth.organizationId, userId: profile.userId }).lean(),
    TeamMember.find({ organizationId: req.auth.organizationId, userId: profile.userId }).lean()
  ]);

  const teamIds = teamMemberships.map((tm) => tm.teamId);
  const teams = await Team.find({ organizationId: req.auth.organizationId, _id: { $in: teamIds } }).lean();
  const teamMap = new Map(teams.map((t) => [t._id.toString(), t]));

  let primaryTeam = null;
  if (profile.primaryTeamId) {
    const pt = await Team.findOne({ organizationId: req.auth.organizationId, _id: profile.primaryTeamId }).lean();
    if (pt) primaryTeam = { id: pt._id, code: pt.teamCode, name: pt.name };
  }

  res.json({
    profile: {
      id: profile._id,
      _id: profile._id,
      employeeCode: profile.employeeCode,
      displayName: profile.displayName,
      email: user?.email || '',
      phone: profile.phone || '',
      designation: profile.designation || '',
      department: profile.department || '',
      status: profile.status,
      primaryTeamId: profile.primaryTeamId || null,
      createdBy: profile.createdBy,
      updatedBy: profile.updatedBy,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    },
    user: user ? {
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      lastActiveAt: user.lastActiveAt
    } : null,
    organizationMembership: orgMember ? {
      role: orgMember.organizationRole,
      status: orgMember.status,
      createdAt: orgMember.createdAt
    } : null,
    primaryTeam,
    teams: teamMemberships.map((tm) => {
      const t = teamMap.get(tm.teamId.toString());
      return {
        teamId: tm.teamId,
        teamCode: t?.teamCode || '',
        teamName: t?.name || '',
        membershipRole: tm.membershipRole,
        status: tm.status,
        joinedAt: tm.joinedAt,
        leftAt: tm.leftAt
      };
    })
  });
}));

// POST create employee profile
router.post('/organizations/:organizationId/employees', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const {
    userId,
    email,
    employeeCode,
    displayName,
    phone,
    designation,
    department,
    primaryTeamId,
    status
  } = req.body;

  let resolvedUser = null;
  if (userId) {
    resolvedUser = await User.findById(userId);
  } else if (email) {
    resolvedUser = await User.findOne({ email: String(email).toLowerCase().trim() });
  }

  if (!resolvedUser) {
    throw new ApiError(400, 'User not found in organization. New-user invitation is deferred in A1A.');
  }

  // Ensure user has active membership in this organization
  const orgMember = await OrganizationMember.findOne({
    organizationId: req.auth.organizationId,
    userId: resolvedUser._id,
    status: 'ACTIVE'
  });
  if (!orgMember) {
    throw new ApiError(400, 'User is not an active member of this organization');
  }

  // Check unique compound: organizationId + userId
  const existingProfile = await EmployeeProfile.findOne({
    organizationId: req.auth.organizationId,
    userId: resolvedUser._id
  });
  if (existingProfile) {
    throw new ApiError(409, 'Employee profile already exists for this user in this organization');
  }

  // Employee Code
  let finalCode = (employeeCode || '').trim().toUpperCase();
  if (finalCode) {
    const codeExists = await EmployeeProfile.findOne({
      organizationId: req.auth.organizationId,
      employeeCode: finalCode
    });
    if (codeExists) {
      throw new ApiError(409, `Employee code ${finalCode} already exists in this organization`);
    }
  } else {
    finalCode = await generateNextEmployeeCode(req.auth.organizationId);
  }

  // Validate primaryTeamId if supplied
  if (primaryTeamId) {
    const pt = await Team.findOne({
      _id: primaryTeamId,
      organizationId: req.auth.organizationId,
      status: 'ACTIVE'
    });
    if (!pt) {
      throw new ApiError(400, 'Primary team must be an active team in this organization');
    }
  }

  const profile = await EmployeeProfile.create({
    organizationId: req.auth.organizationId,
    userId: resolvedUser._id,
    employeeCode: finalCode,
    displayName: (displayName || resolvedUser.displayName || '').trim(),
    phone: (phone || '').trim(),
    designation: (designation || '').trim(),
    department: (department || '').trim(),
    status: status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    primaryTeamId: primaryTeamId || undefined,
    createdBy: req.auth.userId,
    updatedBy: req.auth.userId
  });

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'EMPLOYEE_CREATED',
    resourceType: 'EmployeeProfile',
    resourceId: profile._id,
    newState: profile.toObject()
  });

  res.status(201).json({
    ...profile.toObject(),
    id: profile._id,
    email: resolvedUser.email,
    organizationRole: orgMember.organizationRole
  });
}));

// PATCH update employee profile
router.patch('/organizations/:organizationId/employees/:employeeId', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const profile = await EmployeeProfile.findOne({
    _id: req.params.employeeId,
    organizationId: req.auth.organizationId
  });
  if (!profile) throw new ApiError(404, 'Employee profile not found');

  const before = profile.toObject();

  if (req.body.displayName !== undefined) profile.displayName = String(req.body.displayName).trim();
  if (req.body.phone !== undefined) profile.phone = String(req.body.phone).trim();
  if (req.body.designation !== undefined) profile.designation = String(req.body.designation).trim();
  if (req.body.department !== undefined) profile.department = String(req.body.department).trim();

  if (req.body.primaryTeamId !== undefined) {
    if (req.body.primaryTeamId) {
      const pt = await Team.findOne({
        _id: req.body.primaryTeamId,
        organizationId: req.auth.organizationId,
        status: 'ACTIVE'
      });
      if (!pt) throw new ApiError(400, 'Primary team must be an active team in this organization');
      profile.primaryTeamId = pt._id;
    } else {
      profile.primaryTeamId = undefined;
    }
  }

  if (req.body.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be ACTIVE or INACTIVE');
    }
    profile.status = req.body.status;
  }

  profile.updatedBy = req.auth.userId;
  await profile.save();

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'EMPLOYEE_UPDATED',
    resourceType: 'EmployeeProfile',
    resourceId: profile._id,
    previousState: before,
    newState: profile.toObject()
  });

  res.json({ ...profile.toObject(), id: profile._id });
}));

// PATCH / POST employee status
const handleEmployeeStatusChange = asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const status = req.body.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw new ApiError(400, 'Status must be ACTIVE or INACTIVE');
  }

  const profile = await EmployeeProfile.findOne({
    _id: req.params.employeeId,
    organizationId: req.auth.organizationId
  });
  if (!profile) throw new ApiError(404, 'Employee profile not found');

  const before = profile.toObject();
  profile.status = status;
  profile.updatedBy = req.auth.userId;
  await profile.save();

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'EMPLOYEE_STATUS_CHANGED',
    resourceType: 'EmployeeProfile',
    resourceId: profile._id,
    previousState: before,
    newState: profile.toObject()
  });

  res.json({ ...profile.toObject(), id: profile._id });
});

router.patch('/organizations/:organizationId/employees/:employeeId/status', handleEmployeeStatusChange);
router.post('/organizations/:organizationId/employees/:employeeId/status', handleEmployeeStatusChange);

// ============================================================================
// 3. TEAMS
// ============================================================================

// GET all teams in organization
router.get('/organizations/:organizationId/teams', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  const teams = await Team.find({ organizationId: req.auth.organizationId })
    .sort({ createdAt: -1 })
    .lean();

  const teamIds = teams.map((t) => t._id);
  const leadUserIds = teams.map((t) => t.teamLeadUserId).filter(Boolean);

  const orgObjectId = new mongoose.Types.ObjectId(String(req.auth.organizationId));
  const teamObjectIds = teamIds.map((id) => new mongoose.Types.ObjectId(String(id)));

  const [leadUsers, activeMemberAgg, totalMemberAgg] = await Promise.all([
    User.find({ _id: { $in: leadUserIds } }).select('displayName email').lean(),
    TeamMember.aggregate([
      { $match: { organizationId: orgObjectId, teamId: { $in: teamObjectIds }, status: 'ACTIVE' } },
      { $group: { _id: '$teamId', count: { $sum: 1 } } }
    ]),
    TeamMember.aggregate([
      { $match: { organizationId: orgObjectId, teamId: { $in: teamObjectIds } } },
      { $group: { _id: '$teamId', count: { $sum: 1 } } }
    ])
  ]);

  const leadUserMap = new Map(leadUsers.map((u) => [u._id.toString(), u]));
  const activeCountMap = new Map(activeMemberAgg.map((a) => [a._id.toString(), a.count]));
  const totalCountMap = new Map(totalMemberAgg.map((a) => [a._id.toString(), a.count]));

  const response = teams.map((t) => {
    const lead = t.teamLeadUserId ? leadUserMap.get(t.teamLeadUserId.toString()) : null;
    return {
      id: t._id,
      _id: t._id,
      teamCode: t.teamCode,
      name: t.name,
      description: t.description || '',
      functionLabel: t.functionLabel || '',
      status: t.status,
      teamLeadUserId: t.teamLeadUserId,
      teamLead: lead ? { id: lead._id, displayName: lead.displayName, email: lead.email } : null,
      activeMemberCount: activeCountMap.get(t._id.toString()) || 0,
      memberCount: totalCountMap.get(t._id.toString()) || 0,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    };
  });

  res.json(response);
}));

// GET single team detail
router.get('/organizations/:organizationId/teams/:teamId', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  const team = await Team.findOne({
    _id: req.params.teamId,
    organizationId: req.auth.organizationId
  }).lean();

  if (!team) throw new ApiError(404, 'Team not found');

  const [leadUser, members, projectAccessList] = await Promise.all([
    team.teamLeadUserId ? User.findById(team.teamLeadUserId).select('displayName email').lean() : null,
    TeamMember.find({ teamId: team._id, organizationId: req.auth.organizationId }).lean(),
    ProjectTeamAccess.find({ teamId: team._id, organizationId: req.auth.organizationId }).lean()
  ]);

  const memberUserIds = members.map((m) => m.userId);
  const projectIds = projectAccessList.map((pa) => pa.projectId);

  const [users, profiles, projects] = await Promise.all([
    User.find({ _id: { $in: memberUserIds } }).select('displayName email status').lean(),
    EmployeeProfile.find({ organizationId: req.auth.organizationId, userId: { $in: memberUserIds } }).lean(),
    Project.find({ organizationId: req.auth.organizationId, _id: { $in: projectIds } }).select('name code status location').lean()
  ]);

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const profileMap = new Map(profiles.map((p) => [p.userId.toString(), p]));
  const projectMap = new Map(projects.map((p) => [p._id.toString(), p]));

  const membersResponse = members.map((m) => {
    const user = userMap.get(m.userId.toString());
    const profile = profileMap.get(m.userId.toString());
    return {
      userId: m.userId,
      employeeCode: profile?.employeeCode || null,
      displayName: profile?.displayName || user?.displayName || user?.email || '',
      email: user?.email || '',
      designation: profile?.designation || '',
      department: profile?.department || '',
      membershipRole: m.membershipRole,
      status: m.status,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt
    };
  });

  const projectAccessResponse = projectAccessList.map((pa) => {
    const proj = projectMap.get(pa.projectId.toString());
    return {
      id: pa._id,
      projectId: pa.projectId,
      projectName: proj?.name || '',
      projectCode: proj?.code || '',
      accessProfile: pa.accessProfile || null,
      permissions: pa.permissions || [],
      status: pa.status,
      createdAt: pa.createdAt
    };
  });

  res.json({
    team: {
      id: team._id,
      _id: team._id,
      teamCode: team.teamCode,
      name: team.name,
      description: team.description || '',
      functionLabel: team.functionLabel || '',
      status: team.status,
      teamLeadUserId: team.teamLeadUserId || null,
      teamLead: leadUser ? { id: leadUser._id, displayName: leadUser.displayName, email: leadUser.email } : null,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt
    },
    members: membersResponse,
    projectAccess: projectAccessResponse
  });
}));

// POST create team
router.post('/organizations/:organizationId/teams', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const { name, teamCode, description, functionLabel, teamLeadUserId, status } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Team name is required');

  let finalCode = (teamCode || '').trim().toUpperCase();
  if (finalCode) {
    const codeExists = await Team.findOne({
      organizationId: req.auth.organizationId,
      teamCode: finalCode
    });
    if (codeExists) {
      throw new ApiError(409, `Team code ${finalCode} already exists in this organization`);
    }
  } else {
    finalCode = await generateNextTeamCode(req.auth.organizationId);
  }

  // Validate teamLeadUserId if supplied
  if (teamLeadUserId) {
    const isMember = await OrganizationMember.findOne({
      organizationId: req.auth.organizationId,
      userId: teamLeadUserId,
      status: 'ACTIVE'
    });
    if (!isMember) {
      throw new ApiError(400, 'Team lead must be an active member of this organization');
    }
  }

  const team = await Team.create({
    organizationId: req.auth.organizationId,
    teamCode: finalCode,
    name: name.trim(),
    description: (description || '').trim(),
    functionLabel: (functionLabel || '').trim(),
    status: status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    teamLeadUserId: teamLeadUserId || undefined,
    createdBy: req.auth.userId,
    updatedBy: req.auth.userId
  });

  // If team lead was provided, automatically ensure active membership as LEAD
  if (teamLeadUserId) {
    await TeamMember.findOneAndUpdate(
      { teamId: team._id, userId: teamLeadUserId },
      {
        $set: {
          organizationId: req.auth.organizationId,
          membershipRole: 'LEAD',
          status: 'ACTIVE',
          leftAt: null,
          updatedBy: req.auth.userId
        },
        $setOnInsert: {
          joinedAt: new Date(),
          createdBy: req.auth.userId
        }
      },
      { upsert: true, new: true }
    );
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'TEAM_CREATED',
    resourceType: 'Team',
    resourceId: team._id,
    newState: team.toObject()
  });

  res.status(201).json({ ...team.toObject(), id: team._id });
}));

// PATCH update team
router.patch('/organizations/:organizationId/teams/:teamId', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const team = await Team.findOne({
    _id: req.params.teamId,
    organizationId: req.auth.organizationId
  });
  if (!team) throw new ApiError(404, 'Team not found');

  const before = team.toObject();

  if (req.body.name !== undefined) {
    const trimmed = String(req.body.name).trim();
    if (!trimmed) throw new ApiError(400, 'Team name cannot be empty');
    team.name = trimmed;
  }
  if (req.body.description !== undefined) team.description = String(req.body.description).trim();
  if (req.body.functionLabel !== undefined) team.functionLabel = String(req.body.functionLabel).trim();

  if (req.body.teamCode !== undefined) {
    const code = String(req.body.teamCode).trim().toUpperCase();
    if (code && code !== team.teamCode) {
      const codeExists = await Team.findOne({ organizationId: req.auth.organizationId, teamCode: code });
      if (codeExists) throw new ApiError(409, `Team code ${code} already exists in this organization`);
      team.teamCode = code;
    }
  }

  if (req.body.teamLeadUserId !== undefined) {
    if (req.body.teamLeadUserId) {
      const isMember = await OrganizationMember.findOne({
        organizationId: req.auth.organizationId,
        userId: req.body.teamLeadUserId,
        status: 'ACTIVE'
      });
      if (!isMember) throw new ApiError(400, 'Team lead must be an active member of this organization');
      team.teamLeadUserId = req.body.teamLeadUserId;

      // Upsert lead in TeamMember
      await TeamMember.findOneAndUpdate(
        { teamId: team._id, userId: req.body.teamLeadUserId },
        {
          $set: {
            organizationId: req.auth.organizationId,
            membershipRole: 'LEAD',
            status: 'ACTIVE',
            leftAt: null,
            updatedBy: req.auth.userId
          },
          $setOnInsert: {
            joinedAt: new Date(),
            createdBy: req.auth.userId
          }
        },
        { upsert: true, new: true }
      );
    } else {
      team.teamLeadUserId = undefined;
    }
  }

  if (req.body.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be ACTIVE or INACTIVE');
    }
    team.status = req.body.status;
  }

  team.updatedBy = req.auth.userId;
  await team.save();

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'TEAM_UPDATED',
    resourceType: 'Team',
    resourceId: team._id,
    previousState: before,
    newState: team.toObject()
  });

  res.json({ ...team.toObject(), id: team._id });
}));

// PATCH / POST team status
const handleTeamStatusChange = asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const status = req.body.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw new ApiError(400, 'Status must be ACTIVE or INACTIVE');
  }

  const team = await Team.findOne({
    _id: req.params.teamId,
    organizationId: req.auth.organizationId
  });
  if (!team) throw new ApiError(404, 'Team not found');

  const before = team.toObject();
  team.status = status;
  team.updatedBy = req.auth.userId;
  await team.save();

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'TEAM_STATUS_CHANGED',
    resourceType: 'Team',
    resourceId: team._id,
    previousState: before,
    newState: team.toObject()
  });

  res.json({ ...team.toObject(), id: team._id });
});

router.patch('/organizations/:organizationId/teams/:teamId/status', handleTeamStatusChange);
router.post('/organizations/:organizationId/teams/:teamId/status', handleTeamStatusChange);

// ============================================================================
// 4. TEAM MEMBERSHIP
// ============================================================================

// GET members of a team
router.get('/organizations/:organizationId/teams/:teamId/members', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  const team = await Team.findOne({
    _id: req.params.teamId,
    organizationId: req.auth.organizationId
  });
  if (!team) throw new ApiError(404, 'Team not found');

  const members = await TeamMember.find({
    teamId: team._id,
    organizationId: req.auth.organizationId
  }).lean();

  const userIds = members.map((m) => m.userId);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('displayName email status').lean(),
    EmployeeProfile.find({ organizationId: req.auth.organizationId, userId: { $in: userIds } }).lean()
  ]);

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const profileMap = new Map(profiles.map((p) => [p.userId.toString(), p]));

  const response = members.map((m) => {
    const user = userMap.get(m.userId.toString());
    const profile = profileMap.get(m.userId.toString());
    return {
      userId: m.userId,
      employeeCode: profile?.employeeCode || null,
      displayName: profile?.displayName || user?.displayName || user?.email || '',
      email: user?.email || '',
      designation: profile?.designation || '',
      department: profile?.department || '',
      membershipRole: m.membershipRole,
      status: m.status,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt
    };
  });

  res.json(response);
}));

// POST add member to team
router.post('/organizations/:organizationId/teams/:teamId/members', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const team = await Team.findOne({
    _id: req.params.teamId,
    organizationId: req.auth.organizationId
  });
  if (!team) throw new ApiError(404, 'Team not found');

  // Section 32: Inactive team cannot receive new active members
  if (team.status === 'INACTIVE') {
    throw new ApiError(400, 'Cannot add active members to an inactive team');
  }

  const { userId, email, membershipRole, status } = req.body;
  let targetUser = null;
  if (userId) {
    targetUser = await User.findById(userId);
  } else if (email) {
    targetUser = await User.findOne({ email: String(email).toLowerCase().trim() });
  }

  if (!targetUser) throw new ApiError(400, 'User not found');

  // Verify user belongs to this organization (CROSS-ORG PREVENTION)
  const orgMember = await OrganizationMember.findOne({
    organizationId: req.auth.organizationId,
    userId: targetUser._id,
    status: 'ACTIVE'
  });
  if (!orgMember) {
    throw new ApiError(400, 'User does not belong to this organization or membership is not active');
  }

  // Check existing membership
  const existingMember = await TeamMember.findOne({
    teamId: team._id,
    userId: targetUser._id
  });

  if (existingMember) {
    if (existingMember.status === 'ACTIVE') {
      throw new ApiError(409, 'User is already an active member of this team');
    }
    // Reactivate
    const before = existingMember.toObject();
    existingMember.status = 'ACTIVE';
    existingMember.membershipRole = ['LEAD', 'MEMBER'].includes(membershipRole) ? membershipRole : existingMember.membershipRole;
    existingMember.joinedAt = new Date();
    existingMember.leftAt = undefined;
    existingMember.updatedBy = req.auth.userId;
    await existingMember.save();

    if (existingMember.membershipRole === 'LEAD') {
      team.teamLeadUserId = targetUser._id;
      await team.save();
    }

    await audit({
      req,
      organizationId: req.auth.organizationId,
      action: 'TEAM_MEMBER_REACTIVATED',
      resourceType: 'TeamMember',
      resourceId: existingMember._id,
      previousState: before,
      newState: existingMember.toObject()
    });

    return res.json(existingMember);
  }

  const newMember = await TeamMember.create({
    organizationId: req.auth.organizationId,
    teamId: team._id,
    userId: targetUser._id,
    membershipRole: ['LEAD', 'MEMBER'].includes(membershipRole) ? membershipRole : 'MEMBER',
    status: status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    joinedAt: new Date(),
    createdBy: req.auth.userId,
    updatedBy: req.auth.userId
  });

  if (newMember.membershipRole === 'LEAD') {
    team.teamLeadUserId = targetUser._id;
    await team.save();
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'TEAM_MEMBER_ADDED',
    resourceType: 'TeamMember',
    resourceId: newMember._id,
    newState: newMember.toObject()
  });

  res.status(201).json(newMember);
}));

// PATCH update team member role / status
router.patch('/organizations/:organizationId/teams/:teamId/members/:userId', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const member = await TeamMember.findOne({
    teamId: req.params.teamId,
    userId: req.params.userId,
    organizationId: req.auth.organizationId
  });
  if (!member) throw new ApiError(404, 'Team member not found');

  const before = member.toObject();

  if (req.body.membershipRole !== undefined) {
    if (!['LEAD', 'MEMBER'].includes(req.body.membershipRole)) {
      throw new ApiError(400, 'membershipRole must be LEAD or MEMBER');
    }
    member.membershipRole = req.body.membershipRole;
  }

  if (req.body.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) {
      throw new ApiError(400, 'status must be ACTIVE or INACTIVE');
    }
    if (req.body.status === 'ACTIVE') {
      const parentTeam = await Team.findById(req.params.teamId);
      if (parentTeam && parentTeam.status === 'INACTIVE') {
        throw new ApiError(400, 'Cannot activate member in an inactive team');
      }
      member.leftAt = undefined;
    } else {
      member.leftAt = new Date();
    }
    member.status = req.body.status;
  }

  if (member.membershipRole === 'LEAD' && member.status === 'ACTIVE') {
    await Team.findByIdAndUpdate(req.params.teamId, { teamLeadUserId: member.userId, updatedBy: req.auth.userId });
  }

  member.updatedBy = req.auth.userId;
  await member.save();

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'TEAM_MEMBER_UPDATED',
    resourceType: 'TeamMember',
    resourceId: member._id,
    previousState: before,
    newState: member.toObject()
  });

  res.json(member);
}));

// DELETE or deactivate team member
router.delete('/organizations/:organizationId/teams/:teamId/members/:userId', asyncHandler(async (req, res) => {
  assertOrgIsolation(req, req.params.organizationId);
  requireAdmin(req);

  const member = await TeamMember.findOne({
    teamId: req.params.teamId,
    userId: req.params.userId,
    organizationId: req.auth.organizationId
  });
  if (!member) throw new ApiError(404, 'Team member not found');

  const before = member.toObject();
  member.status = 'INACTIVE';
  member.leftAt = new Date();
  member.updatedBy = req.auth.userId;
  await member.save();

  await audit({
    req,
    organizationId: req.auth.organizationId,
    action: 'TEAM_MEMBER_DEACTIVATED',
    resourceType: 'TeamMember',
    resourceId: member._id,
    previousState: before,
    newState: member.toObject()
  });

  res.json({ message: 'Team member deactivated', teamMember: member });
}));

// ============================================================================
// 5. PROJECT TEAM ACCESS
// ============================================================================

// GET all team access records for a project
router.get(
  '/projects/:projectId/team-access',
  requireProjectAccess,
  requireProjectPermission('administration.view'),
  asyncHandler(async (req, res) => {
    const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);

    const accessRecords = await ProjectTeamAccess.find({
      projectId: project._id,
      organizationId: req.auth.organizationId
    }).lean();

    const teamIds = accessRecords.map((a) => a.teamId);
    const teams = await Team.find({ organizationId: req.auth.organizationId, _id: { $in: teamIds } }).lean();
    const teamMap = new Map(teams.map((t) => [t._id.toString(), t]));

    const leadUserIds = teams.map((t) => t.teamLeadUserId).filter(Boolean);
    const orgObjectId = new mongoose.Types.ObjectId(String(req.auth.organizationId));
    const teamObjectIds = teamIds.map((id) => new mongoose.Types.ObjectId(String(id)));

    const [leadUsers, activeMemberAgg] = await Promise.all([
      User.find({ _id: { $in: leadUserIds } }).select('displayName email').lean(),
      TeamMember.aggregate([
        { $match: { organizationId: orgObjectId, teamId: { $in: teamObjectIds }, status: 'ACTIVE' } },
        { $group: { _id: '$teamId', count: { $sum: 1 } } }
      ])
    ]);

    const leadUserMap = new Map(leadUsers.map((u) => [u._id.toString(), u]));
    const memberCountMap = new Map(activeMemberAgg.map((a) => [a._id.toString(), a.count]));

    const rows = accessRecords.map((a) => {
      const team = teamMap.get(a.teamId.toString());
      const lead = team?.teamLeadUserId ? leadUserMap.get(team.teamLeadUserId.toString()) : null;
      return {
        id: a._id,
        _id: a._id,
        teamId: a.teamId,
        teamCode: team?.teamCode || '',
        teamName: team?.name || '',
        teamLead: lead ? (lead.displayName || lead.email) : null,
        activeMemberCount: memberCountMap.get(a.teamId.toString()) || 0,
        accessProfile: a.accessProfile || null,
        permissions: a.permissions || [],
        status: a.status,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt
      };
    });

    res.json(rows);
  })
);

// GET single team access record on project
router.get(
  '/projects/:projectId/team-access/:teamId',
  requireProjectAccess,
  requireProjectPermission('administration.view'),
  asyncHandler(async (req, res) => {
    const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);

    const access = await ProjectTeamAccess.findOne({
      projectId: project._id,
      teamId: req.params.teamId,
      organizationId: req.auth.organizationId
    }).lean();

    if (!access) throw new ApiError(404, 'Team access record not found for this project');

    const team = await Team.findOne({ _id: access.teamId, organizationId: req.auth.organizationId }).lean();
    res.json({
      ...access,
      id: access._id,
      teamCode: team?.teamCode,
      teamName: team?.name
    });
  })
);

// POST assign team to project with access profile / permissions
router.post(
  '/projects/:projectId/team-access',
  requireProjectAccess,
  requireProjectPermission('administration.manageAccess'),
  asyncHandler(async (req, res) => {
    if (req.projectAccessMode !== 'TEAM_PERMISSIONS') {
      requireAdmin(req);
    }
    const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);

  const { teamId, accessProfile, permissions, status } = req.body;
  if (!teamId) throw new ApiError(400, 'teamId is required');

  // Verify Team belongs to same organization (PROJECT & TEAM ISOLATION)
  const team = await Team.findOne({ _id: teamId, organizationId: req.auth.organizationId });
  if (!team) {
    throw new ApiError(400, 'Team does not belong to the project organization');
  }

  // Inactive team check
  if (team.status === 'INACTIVE') {
    throw new ApiError(400, 'Cannot assign inactive team to project');
  }

  // Check unique active assignment
  const existingAccess = await ProjectTeamAccess.findOne({
    projectId: project._id,
    teamId: team._id,
    organizationId: req.auth.organizationId
  });

  if (existingAccess && existingAccess.status === 'ACTIVE') {
    throw new ApiError(409, 'Active team access already exists for this project and team');
  }

  // Determine permissions
  let finalPermissions = [];
  let finalProfile = accessProfile ? String(accessProfile).trim().toUpperCase() : 'CUSTOM';

  if (Array.isArray(permissions) && permissions.length > 0) {
    // Validate permission strings
    const check = validatePermissions(permissions);
    if (!check.valid) {
      throw new ApiError(400, `Unknown permission key(s): ${check.invalid.join(', ')}`);
    }
    finalPermissions = permissions;
  } else if (finalProfile && ACCESS_PROFILES[finalProfile]) {
    finalPermissions = [...ACCESS_PROFILES[finalProfile].permissions];
  }

  if (existingAccess) {
    // Reactivate existing record
    const before = existingAccess.toObject();
    existingAccess.status = 'ACTIVE';
    existingAccess.accessProfile = finalProfile;
    existingAccess.permissions = finalPermissions;
    existingAccess.updatedBy = req.auth.userId;
    await existingAccess.save();

    await audit({
      req,
      organizationId: req.auth.organizationId,
      projectId: project._id,
      action: 'PROJECT_TEAM_ACCESS_REACTIVATED',
      resourceType: 'ProjectTeamAccess',
      resourceId: existingAccess._id,
      previousState: before,
      newState: existingAccess.toObject()
    });

    return res.json({ ...existingAccess.toObject(), id: existingAccess._id });
  }

  const access = await ProjectTeamAccess.create({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    teamId: team._id,
    status: status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    accessProfile: finalProfile,
    permissions: finalPermissions,
    createdBy: req.auth.userId,
    updatedBy: req.auth.userId
  });

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId: project._id,
    action: 'PROJECT_TEAM_ACCESS_GRANTED',
    resourceType: 'ProjectTeamAccess',
    resourceId: access._id,
    newState: access.toObject()
  });

  res.status(201).json({ ...access.toObject(), id: access._id });
}));

// PATCH update project team access permissions / profile
router.patch(
  '/projects/:projectId/team-access/:teamId',
  requireProjectAccess,
  requireProjectPermission('administration.manageAccess'),
  asyncHandler(async (req, res) => {
    if (req.projectAccessMode !== 'TEAM_PERMISSIONS') {
      requireAdmin(req);
    }
    const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);

    const access = await ProjectTeamAccess.findOne({
      projectId: project._id,
      teamId: req.params.teamId,
      organizationId: req.auth.organizationId
    });
    if (!access) throw new ApiError(404, 'Team access record not found for this project');

    const before = access.toObject();

    if (req.body.permissions !== undefined) {
      const check = validatePermissions(req.body.permissions);
      if (!check.valid) {
        throw new ApiError(400, `Unknown permission key(s): ${check.invalid.join(', ')}`);
      }
      access.permissions = req.body.permissions;
    }

    if (req.body.accessProfile !== undefined) {
      const prof = String(req.body.accessProfile).trim().toUpperCase();
      access.accessProfile = prof;
      if (req.body.permissions === undefined && ACCESS_PROFILES[prof]) {
        access.permissions = [...ACCESS_PROFILES[prof].permissions];
      }
    }

    if (req.body.status !== undefined) {
      if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) {
        throw new ApiError(400, 'Status must be ACTIVE or INACTIVE');
      }
      access.status = req.body.status;
    }

    access.updatedBy = req.auth.userId;
    await access.save();

    await audit({
      req,
      organizationId: req.auth.organizationId,
      projectId: project._id,
      action: 'PROJECT_TEAM_ACCESS_UPDATED',
      resourceType: 'ProjectTeamAccess',
      resourceId: access._id,
      previousState: before,
      newState: access.toObject()
    });

    res.json({ ...access.toObject(), id: access._id });
  })
);

// PATCH / POST project team access status
const handleProjectTeamAccessStatus = asyncHandler(async (req, res) => {
  if (req.projectAccessMode !== 'TEAM_PERMISSIONS') {
    requireAdmin(req);
  }
  const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);

  const status = req.body.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw new ApiError(400, 'Status must be ACTIVE or INACTIVE');
  }

  const access = await ProjectTeamAccess.findOne({
    projectId: project._id,
    teamId: req.params.teamId,
    organizationId: req.auth.organizationId
  });
  if (!access) throw new ApiError(404, 'Team access record not found for this project');

  const before = access.toObject();
  access.status = status;
  access.updatedBy = req.auth.userId;
  await access.save();

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId: project._id,
    action: 'PROJECT_TEAM_ACCESS_STATUS_CHANGED',
    resourceType: 'ProjectTeamAccess',
    resourceId: access._id,
    previousState: before,
    newState: access.toObject()
  });

  res.json({ ...access.toObject(), id: access._id });
});

router.patch(
  '/projects/:projectId/team-access/:teamId/status',
  requireProjectAccess,
  requireProjectPermission('administration.manageAccess'),
  handleProjectTeamAccessStatus
);
router.post(
  '/projects/:projectId/team-access/:teamId/status',
  requireProjectAccess,
  requireProjectPermission('administration.manageAccess'),
  handleProjectTeamAccessStatus
);

// ============================================================================
// 6. EFFECTIVE PERMISSIONS RESOLUTION ENDPOINT
// ============================================================================

router.get('/projects/:projectId/effective-permissions', asyncHandler(async (req, res) => {
  const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);
  const result = await getUserProjectTeamPermissions({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    userId: req.auth.userId
  });
  res.json({
    ...result,
    accessMode: project.accessMode || 'ROLE_BASED'
  });
}));

router.get('/projects/:projectId/effective-permissions/:userId', asyncHandler(async (req, res) => {
  const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);
  const result = await getUserProjectTeamPermissions({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    userId: req.params.userId
  });
  res.json({
    ...result,
    accessMode: project.accessMode || 'ROLE_BASED'
  });
}));

// ============================================================================
// 7. PROJECT ACCESS MODE & READINESS ENDPOINTS (Phase A1D)
// ============================================================================

/**
 * GET /api/v1/projects/:projectId/access-mode
 * Retrieve current project access mode ('ROLE_BASED' or 'TEAM_PERMISSIONS').
 */
router.get('/projects/:projectId/access-mode', asyncHandler(async (req, res) => {
  const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);
  res.json({
    projectId: project._id,
    accessMode: project.accessMode || 'ROLE_BASED'
  });
}));

/**
 * GET /api/v1/projects/:projectId/access-mode/readiness
 * Validate if all active non-admin ProjectMembers have active team assignments
 * and permissions before enabling TEAM_PERMISSIONS.
 */
router.get('/projects/:projectId/access-mode/readiness', asyncHandler(async (req, res) => {
  const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);
  const readiness = await calculateProjectAccessReadiness({
    organizationId: req.auth.organizationId,
    projectId: project._id
  });
  res.json(readiness);
}));

/**
 * PATCH /api/v1/projects/:projectId/access-mode
 * Switch access mode between ROLE_BASED and TEAM_PERMISSIONS.
 * Switching to TEAM_PERMISSIONS enforces readiness check.
 * Reverting to ROLE_BASED restores legacy role behavior without deleting team data.
 */
router.patch('/projects/:projectId/access-mode', asyncHandler(async (req, res) => {
  requireAdmin(req);
  const project = await getVerifiedProject(req.params.projectId, req.auth.organizationId);
  const { accessMode } = req.body;

  if (!accessMode || !['ROLE_BASED', 'TEAM_PERMISSIONS'].includes(accessMode)) {
    throw new ApiError(400, "accessMode must be either 'ROLE_BASED' or 'TEAM_PERMISSIONS'");
  }

  const prevMode = project.accessMode || 'ROLE_BASED';

  // If enabling TEAM_PERMISSIONS, validate readiness:
  if (accessMode === 'TEAM_PERMISSIONS') {
    const readiness = await calculateProjectAccessReadiness({
      organizationId: req.auth.organizationId,
      projectId: project._id
    });
    if (!readiness.isReady) {
      return res.status(400).json({
        message: `Cannot enable Team Permissions: ${readiness.uncoveredMembers} active project member(s) have zero effective permissions.`,
        readiness
      });
    }
  }

  await Project.updateOne({ _id: project._id }, { accessMode });

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId: project._id,
    action: 'PROJECT_ACCESS_MODE_UPDATED',
    resourceType: 'Project',
    resourceId: project._id,
    previousState: { accessMode: prevMode },
    newState: { accessMode }
  });

  res.json({
    projectId: project._id,
    accessMode,
    message: `Project access mode successfully updated to ${accessMode}.`
  });
}));

// ============================================================================
// 8. EMPLOYEE INVITATION MANAGEMENT ENDPOINTS (Phase A1F)
// ============================================================================

async function requireEmployeeInvitationAccess(req) {
  const projectId = req.params.projectId || req.body?.projectId;
  if (!projectId) throw new ApiError(400, 'Project ID is required');

  const userOrgId = req.auth?.organizationId?.toString();
  if (!userOrgId) throw new ApiError(403, 'Organization context missing');

  const project = await Project.findById(projectId).select('organizationId accessMode').lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const projOrgId = project.organizationId?.toString();
  if (!projOrgId || userOrgId !== projOrgId) {
    throw new ApiError(403, 'Forbidden: Organization access mismatch');
  }

  // Administrator override check
  if (req.auth.organizationRole === 'ADMINISTRATOR') {
    return project;
  }

  const projectMembership = await ProjectMember.findOne({
    projectId: project._id,
    userId: req.auth.userId,
    status: 'ACTIVE'
  }).lean();

  if (!projectMembership) {
    throw new ApiError(403, 'No access to this project');
  }

  if (projectMembership.role === 'ADMINISTRATOR') {
    return project;
  }

  // If in TEAM_PERMISSIONS mode, check administration.manageEmployees
  const accessMode = project.accessMode || 'ROLE_BASED';
  if (accessMode === 'TEAM_PERMISSIONS') {
    const teamPerms = await getUserProjectTeamPermissions({
      organizationId: project.organizationId,
      projectId: project._id,
      userId: req.auth.userId
    });
    if (teamPerms.permissions && teamPerms.permissions.includes('administration.manageEmployees')) {
      return project;
    }
  }

  throw new ApiError(403, 'Administrator access or employee management permission required');
}

function getClientBaseUrl(req) {
  const origin = req.get('origin') || req.get('referer');
  if (origin) {
    try {
      const u = new URL(origin);
      return `${u.protocol}//${u.host}`;
    } catch (_) {}
  }
  return env.appUrl || 'http://localhost:4200';
}

const createEmployeeInvitationSchema = z.object({
  displayName: z.string().min(1, 'Display name is required'),
  email: z.string().email('Valid email is required'),
  employeeCode: z.string().optional(),
  designation: z.string().optional(),
  department: z.string().optional(),
  phone: z.string().optional(),
  organizationRole: z.enum(['ADMINISTRATOR', 'ENGINEER', 'OPERATOR', 'VIEWER']).default('ENGINEER'),
  projectRole: z.enum(['ADMINISTRATOR', 'ENGINEER', 'OPERATOR', 'VIEWER']).default('ENGINEER')
});

router.get('/projects/:projectId/employee-invitations', asyncHandler(async (req, res) => {
  const project = await requireEmployeeInvitationAccess(req);
  const rows = await listEmployeeInvitations({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    status: req.query.status
  });
  res.json(rows);
}));

router.post('/projects/:projectId/employee-invitations', asyncHandler(async (req, res) => {
  const project = await requireEmployeeInvitationAccess(req);
  const validated = createEmployeeInvitationSchema.parse(req.body);

  const result = await createEmployeeInvitation({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    invitedByUserId: req.auth.userId,
    payload: validated,
    baseUrl: getClientBaseUrl(req)
  });

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId: project._id,
    action: 'EMPLOYEE_INVITATION_CREATED',
    resourceType: 'EmployeeInvitation',
    resourceId: result.invitation.id,
    newState: result.invitation
  });

  res.status(201).json(result);
}));

router.get('/projects/:projectId/employee-invitations/:invitationId', asyncHandler(async (req, res) => {
  const project = await requireEmployeeInvitationAccess(req);
  const inv = await getEmployeeInvitation({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    invitationId: req.params.invitationId
  });
  res.json(inv);
}));

router.post('/projects/:projectId/employee-invitations/:invitationId/regenerate', asyncHandler(async (req, res) => {
  const project = await requireEmployeeInvitationAccess(req);
  const result = await regenerateEmployeeInvitation({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    invitationId: req.params.invitationId,
    userId: req.auth.userId,
    baseUrl: getClientBaseUrl(req)
  });

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId: project._id,
    action: 'EMPLOYEE_INVITATION_REGENERATED',
    resourceType: 'EmployeeInvitation',
    resourceId: req.params.invitationId,
    newState: { status: result.status, expiresAt: result.expiresAt }
  });

  res.json(result);
}));

router.post('/projects/:projectId/employee-invitations/:invitationId/revoke', asyncHandler(async (req, res) => {
  const project = await requireEmployeeInvitationAccess(req);
  const result = await revokeEmployeeInvitation({
    organizationId: req.auth.organizationId,
    projectId: project._id,
    invitationId: req.params.invitationId,
    userId: req.auth.userId
  });

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId: project._id,
    action: 'EMPLOYEE_INVITATION_REVOKED',
    resourceType: 'EmployeeInvitation',
    resourceId: req.params.invitationId,
    newState: { status: result.status, revokedAt: result.revokedAt }
  });

  res.json(result);
}));

export default router;

