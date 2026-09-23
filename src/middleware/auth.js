import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/api-error.js';
import { OrganizationMember, ProjectMember, User } from '../models/index.js';

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'Authentication required');
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


export async function ensureProjectAccess(req, projectId) {
  if (!req.auth) throw new ApiError(401, 'Authentication required');
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
