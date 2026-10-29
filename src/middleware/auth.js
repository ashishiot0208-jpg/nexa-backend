import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/api-error.js';
import mongoose from 'mongoose';
import { OrganizationMember, ProjectMember, User, Project } from '../models/index.js';
import { getUserProjectTeamPermissions } from '../services/workforce-permission.service.js';
import { ALL_PERMISSION_KEYS } from '../config/permissions.js';

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'AuthReq');
    const payload = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(payload.sub).lean();
    if (!user || user.status !== 'ACTIVE') throw new ApiError(401, 'User is not active');
    req.auth = {
      userId: user._id.toString(),
      email: user.email,
      displayName: user.displayName,
      organizationId: payload.organizationId,
      organizationRole: payload.organizationRole
    };
    next();
  } catch (err) {
    next(err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' ? new ApiError(401, 'Invalid or expired token') : err);
  }
}

export async function requirePlatformAdminAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'AuthReq');
    const payload = jwt.verify(token, env.jwtSecret);
    if (payload.accountType !== 'PLATFORM_ADMIN') throw new ApiError(403, 'Platform Admin access required');
    const admin = await mongoose.model('PlatformAdmin').findById(payload.sub).lean();
    if (!admin || admin.status !== 'ACTIVE') throw new ApiError(401, 'Admin account is not active');
    req.adminAuth = {
      adminId: admin._id.toString(),
      email: admin.email,
      name: admin.name
    };
    next();
  } catch (err) {
    next(err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' ? new ApiError(401, 'Invalid or expired token') : err);
  }
}


export async function ensureProjectAccess(req, projectId) {
  if (!req.auth) throw new ApiError(401, 'AuthReq');
  if (req.auth.organizationRole === 'ADMINISTRATOR') return 'ADMINISTRATOR';
  const membership = await ProjectMember.findOne({ projectId, userId: req.auth.userId, status: 'ACTIVE' }).lean();
  if (!membership) throw new ApiError(403, 'No access to this project');
  return membership.role;
}

export function requireOrgRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.organizationRole)) return next(new ApiError(403, 'Insufficient organisation permission'));
    next();
  };
}

export async function requireProjectAccess(req, _res, next) {
  try {
    const projectId = req.params.projectId || req.params.id || req.body?.projectId || req.query?.projectId;
    if (!projectId) throw new ApiError(400, 'Project id is required');

    const project = await Project.findById(projectId).select('organizationId accessMode').lean();
    if (!project) throw new ApiError(404, 'Project not found');
    req.projectAccessMode = project.accessMode || 'ROLE_BASED';

    if (req.auth.organizationRole === 'ADMINISTRATOR') {
      req.projectRole = 'ADMINISTRATOR';
      return next();
    }
    const membership = await ProjectMember.findOne({ projectId, userId: req.auth.userId, status: 'ACTIVE' }).lean();
    if (!membership) throw new ApiError(403, 'No access to this project');
    req.projectRole = membership.role;
    next();
  } catch (err) { next(err); }
}

/**
 * Central Permission Middleware (Phase A1D)
 *
 * Enforces action/module level permissions in TEAM_PERMISSIONS mode.
 * In ROLE_BASED mode, legacy project-role behavior is preserved.
 *
 * STEP 1: requireProjectAccess verification. User must be a valid ProjectMember or Org Administrator.
 * STEP 2: Administrator override check. Effective Administrators receive full access without needing team membership.
 * STEP 3: If accessMode is ROLE_BASED, allow through.
 * STEP 4: If accessMode is TEAM_PERMISSIONS, resolve getUserProjectTeamPermissions({ organizationId, projectId, userId }).
 *         Require requested permissionKey (or at least one if an array of keys is supplied).
 *         If missing, deny with HTTP 403.
 */
export function requireProjectPermission(permissionKey) {
  return async (req, _res, next) => {
    try {
      const projectId = req.params.projectId || req.params.id || req.body?.projectId || req.query?.projectId;
      if (!projectId) throw new ApiError(400, 'Project id is required');

      let project = null;
      if (!req.projectRole) {
        project = await Project.findById(projectId).select('organizationId accessMode').lean();
        if (!project) throw new ApiError(404, 'Project not found');
        req.projectAccessMode = project.accessMode || 'ROLE_BASED';

        if (req.auth?.organizationRole === 'ADMINISTRATOR') {
          req.projectRole = 'ADMINISTRATOR';
        } else {
          const membership = await ProjectMember.findOne({ projectId, userId: req.auth?.userId, status: 'ACTIVE' }).lean();
          if (!membership) throw new ApiError(403, 'No access to this project');
          req.projectRole = membership.role;
        }
      } else if (!req.projectAccessMode) {
        project = await Project.findById(projectId).select('organizationId accessMode').lean();
        if (!project) throw new ApiError(404, 'Project not found');
        req.projectAccessMode = project.accessMode || 'ROLE_BASED';
      }

      const accessMode = req.projectAccessMode || 'ROLE_BASED';

      // STEP 2: Administrator override check
      const isAdministrator = req.auth?.organizationRole === 'ADMINISTRATOR' || req.projectRole === 'ADMINISTRATOR';
      if (isAdministrator) {
        req.projectPermissions = Array.from(ALL_PERMISSION_KEYS);
        req.projectTeams = [];
        return next();
      }

      // STEP 3: ROLE_BASED Mode check
      if (accessMode === 'ROLE_BASED') {
        return next();
      }

      // STEP 4: TEAM_PERMISSIONS Mode enforcement
      if (!project) {
        project = await Project.findById(projectId).select('organizationId accessMode').lean();
        if (!project) throw new ApiError(404, 'Project not found');
      }

      const userOrgId = req.auth?.organizationId?.toString();
      const projectOrgId = project.organizationId?.toString();
      if (userOrgId && projectOrgId && userOrgId !== projectOrgId) {
        throw new ApiError(403, 'Forbidden: Organization access mismatch');
      }

      const teamPerms = await getUserProjectTeamPermissions({
        organizationId: project.organizationId,
        projectId,
        userId: req.auth.userId
      });

      req.projectPermissions = teamPerms.permissions || [];
      req.projectTeams = teamPerms.teams || [];

      const requiredKeys = Array.isArray(permissionKey) ? permissionKey : [permissionKey];
      const hasPermission = requiredKeys.some((k) => req.projectPermissions.includes(k));

      if (!hasPermission) {
        throw new ApiError(403, `Forbidden: Missing required permission '${requiredKeys.join(', ')}'`);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireProjectRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.projectRole)) return next(new ApiError(403, 'Insufficient project permission'));
    next();
  };
}

export async function attachOrganizationMembership(req, _res, next) {
  try {
    if (!req.auth?.organizationId) return next();
    req.organizationMembership = await OrganizationMember.findOne({ organizationId: req.auth.organizationId, userId: req.auth.userId, status: 'ACTIVE' }).lean();
    next();
  } catch (err) { next(err); }
}
