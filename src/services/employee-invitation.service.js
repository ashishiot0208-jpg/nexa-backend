import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  EmployeeInvitation,
  EmployeeProfile,
  OrganizationMember,
  ProjectMember,
  User,
  Organization,
  Project
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { env } from '../config/env.js';

export async function generateNextEmployeeCode(organizationId) {
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

export function hashInvitationToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateInvitationToken() {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashInvitationToken(rawToken);
  return { rawToken, tokenHash };
}

export async function createEmployeeInvitation({
  organizationId,
  projectId,
  invitedByUserId,
  payload,
  baseUrl = 'http://localhost:4200'
}) {
  const {
    displayName,
    email,
    employeeCode,
    designation,
    department,
    phone,
    organizationRole = 'ENGINEER',
    projectRole = 'ENGINEER'
  } = payload;

  if (!displayName || !displayName.trim()) {
    throw new ApiError(400, 'Display name is required');
  }
  if (!email || !email.trim()) {
    throw new ApiError(400, 'Email is required');
  }

  const emailNormalized = email.toLowerCase().trim();
  const validRoles = ['ADMINISTRATOR', 'ENGINEER', 'OPERATOR', 'VIEWER'];
  if (!validRoles.includes(organizationRole)) {
    throw new ApiError(400, `Invalid organization role: ${organizationRole}`);
  }
  if (!validRoles.includes(projectRole)) {
    throw new ApiError(400, `Invalid project role: ${projectRole}`);
  }

  // 1. Check if user already exists
  const existingUser = await User.findOne({ email: emailNormalized });
  if (existingUser && existingUser.status === 'ACTIVE') {
    const [existingOrgMember, existingProjMember, existingEmpProfile] = await Promise.all([
      OrganizationMember.findOne({ organizationId, userId: existingUser._id, status: 'ACTIVE' }),
      ProjectMember.findOne({ projectId, userId: existingUser._id, status: 'ACTIVE' }),
      EmployeeProfile.findOne({ organizationId, userId: existingUser._id, status: 'ACTIVE' })
    ]);

    if (existingOrgMember && existingProjMember && existingEmpProfile) {
      throw new ApiError(409, 'User already has active membership and employee profile in this organization and project');
    }
  }

  // 2. Prevent multiple active PENDING invitations for (organizationId + projectId + normalized email)
  const activePending = await EmployeeInvitation.findOne({
    organizationId,
    projectId,
    emailNormalized,
    status: 'PENDING',
    expiresAt: { $gt: new Date() }
  });
  if (activePending) {
    throw new ApiError(409, 'An active pending invitation already exists for this email in this project. You may regenerate or revoke it.');
  }

  // 3. Employee Code uniqueness check if provided
  let formattedCode = (employeeCode || '').trim().toUpperCase();
  if (formattedCode) {
    const codeExists = await EmployeeProfile.findOne({
      organizationId,
      employeeCode: formattedCode
    });
    if (codeExists) {
      throw new ApiError(409, `Employee code ${formattedCode} already exists in this organization`);
    }
  }

  // 4. Token generation (32-byte hex, hashed with SHA-256)
  const { rawToken, tokenHash } = generateInvitationToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // 5. Pre-provision User in 'INVITED' state if not existing
  if (!existingUser) {
    const lockedHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await User.create({
      email: emailNormalized,
      displayName: displayName.trim(),
      passwordHash: lockedHash,
      status: 'INVITED'
    });
  }

  // 6. Create EmployeeInvitation record
  const invitation = await EmployeeInvitation.create({
    organizationId,
    projectId,
    emailNormalized,
    displayName: displayName.trim(),
    employeeCode: formattedCode || undefined,
    designation: designation?.trim() || undefined,
    department: department?.trim() || undefined,
    phone: phone?.trim() || undefined,
    organizationRole,
    projectRole,
    status: 'PENDING',
    tokenHash,
    expiresAt,
    invitedByUserId
  });

  const invitationUrl = `${baseUrl.replace(/\/$/, '')}/setup-password?token=${rawToken}`;

  return {
    invitation: {
      id: invitation._id,
      organizationId: invitation.organizationId,
      projectId: invitation.projectId,
      emailNormalized: invitation.emailNormalized,
      displayName: invitation.displayName,
      employeeCode: invitation.employeeCode,
      designation: invitation.designation,
      department: invitation.department,
      phone: invitation.phone,
      organizationRole: invitation.organizationRole,
      projectRole: invitation.projectRole,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt
    },
    rawToken,
    invitationUrl,
    message: 'Employee invitation created successfully'
  };
}

export async function listEmployeeInvitations({ organizationId, projectId, status }) {
  const query = { organizationId, projectId };
  if (status) {
    query.status = status;
  }

  const rows = await EmployeeInvitation.find(query)
    .populate('invitedByUserId', 'displayName email')
    .sort({ createdAt: -1 })
    .lean();

  const now = new Date();
  return rows.map((inv) => {
    let effectiveStatus = inv.status;
    if (inv.status === 'PENDING' && inv.expiresAt < now) {
      effectiveStatus = 'EXPIRED';
    }
    return {
      id: inv._id,
      organizationId: inv.organizationId,
      projectId: inv.projectId,
      emailNormalized: inv.emailNormalized,
      displayName: inv.displayName,
      employeeCode: inv.employeeCode,
      designation: inv.designation,
      department: inv.department,
      phone: inv.phone,
      organizationRole: inv.organizationRole,
      projectRole: inv.projectRole,
      status: effectiveStatus,
      rawStatus: inv.status,
      isExpired: inv.status === 'PENDING' && inv.expiresAt < now,
      expiresAt: inv.expiresAt,
      invitedBy: inv.invitedByUserId ? {
        id: inv.invitedByUserId._id,
        displayName: inv.invitedByUserId.displayName,
        email: inv.invitedByUserId.email
      } : null,
      acceptedAt: inv.acceptedAt,
      revokedAt: inv.revokedAt,
      createdAt: inv.createdAt,
      updatedAt: inv.updatedAt
    };
  });
}

export async function getEmployeeInvitation({ organizationId, projectId, invitationId }) {
  const inv = await EmployeeInvitation.findOne({
    _id: invitationId,
    organizationId,
    projectId
  })
    .populate('invitedByUserId', 'displayName email')
    .lean();

  if (!inv) {
    throw new ApiError(404, 'Employee invitation not found');
  }

  const now = new Date();
  let effectiveStatus = inv.status;
  if (inv.status === 'PENDING' && inv.expiresAt < now) {
    effectiveStatus = 'EXPIRED';
  }

  return {
    id: inv._id,
    organizationId: inv.organizationId,
    projectId: inv.projectId,
    emailNormalized: inv.emailNormalized,
    displayName: inv.displayName,
    employeeCode: inv.employeeCode,
    designation: inv.designation,
    department: inv.department,
    phone: inv.phone,
    organizationRole: inv.organizationRole,
    projectRole: inv.projectRole,
    status: effectiveStatus,
    isExpired: inv.status === 'PENDING' && inv.expiresAt < now,
    expiresAt: inv.expiresAt,
    invitedBy: inv.invitedByUserId,
    acceptedAt: inv.acceptedAt,
    revokedAt: inv.revokedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt
  };
}

export async function regenerateEmployeeInvitation({
  organizationId,
  projectId,
  invitationId,
  userId,
  baseUrl = 'http://localhost:4200'
}) {
  const invitation = await EmployeeInvitation.findOne({
    _id: invitationId,
    organizationId,
    projectId
  });

  if (!invitation) {
    throw new ApiError(404, 'Employee invitation not found');
  }
  if (invitation.status === 'ACCEPTED') {
    throw new ApiError(400, 'Cannot regenerate an invitation that has already been accepted');
  }
  if (invitation.status === 'REVOKED') {
    throw new ApiError(400, 'Cannot regenerate a revoked invitation. Please create a new invitation.');
  }

  const { rawToken, tokenHash } = generateInvitationToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  invitation.tokenHash = tokenHash;
  invitation.expiresAt = expiresAt;
  invitation.status = 'PENDING';
  await invitation.save();

  const invitationUrl = `${baseUrl.replace(/\/$/, '')}/setup-password?token=${rawToken}`;

  return {
    id: invitation._id,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    rawToken,
    invitationUrl,
    message: 'Invitation regenerated successfully'
  };
}

export async function revokeEmployeeInvitation({
  organizationId,
  projectId,
  invitationId,
  userId
}) {
  const invitation = await EmployeeInvitation.findOne({
    _id: invitationId,
    organizationId,
    projectId
  });

  if (!invitation) {
    throw new ApiError(404, 'Employee invitation not found');
  }
  if (invitation.status === 'ACCEPTED') {
    throw new ApiError(400, 'Cannot revoke an invitation that has already been accepted');
  }
  if (invitation.status === 'REVOKED') {
    return { id: invitation._id, status: 'REVOKED', message: 'Invitation is already revoked' };
  }

  invitation.status = 'REVOKED';
  invitation.revokedAt = new Date();
  await invitation.save();

  return {
    id: invitation._id,
    status: invitation.status,
    revokedAt: invitation.revokedAt,
    message: 'Invitation revoked successfully'
  };
}

export async function validateInvitationToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new ApiError(400, 'Invitation token is required');
  }

  const tokenHash = hashInvitationToken(rawToken);
  const invitation = await EmployeeInvitation.findOne({ tokenHash });
  if (!invitation) {
    throw new ApiError(400, 'Invalid or expired setup token');
  }

  if (invitation.status === 'REVOKED') {
    throw new ApiError(400, 'This invitation has been revoked. Please contact your administrator.');
  }
  if (invitation.status === 'ACCEPTED') {
    throw new ApiError(400, 'This invitation has already been accepted.');
  }

  const now = new Date();
  if (invitation.expiresAt < now || invitation.status === 'EXPIRED') {
    if (invitation.status !== 'EXPIRED') {
      invitation.status = 'EXPIRED';
      await invitation.save();
    }
    throw new ApiError(400, 'This invitation has expired. Please ask your administrator to regenerate it.');
  }

  const existingUser = await User.findOne({ email: invitation.emailNormalized });
  const isExistingActiveUser = !!(existingUser && existingUser.status === 'ACTIVE');

  const [org, proj] = await Promise.all([
    Organization.findById(invitation.organizationId).select('name code').lean(),
    Project.findById(invitation.projectId).select('name code').lean()
  ]);

  return {
    valid: true,
    email: invitation.emailNormalized,
    displayName: invitation.displayName,
    organizationName: org?.name || 'Organization',
    projectName: proj?.name || 'Project',
    isExistingActiveUser,
    status: invitation.status,
    expiresAt: invitation.expiresAt
  };
}

async function executeAtomically(fn) {
  let session = null;
  let hasActiveTransaction = false;

  try {
    session = await mongoose.startSession();
    const topology = mongoose.connection.client?.topology?.description?.type;
    if (topology === 'ReplicaSetWithPrimary' || topology === 'Sharded') {
      session.startTransaction();
      hasActiveTransaction = true;
    }
  } catch (_) {
    session = null;
  }

  try {
    const result = await fn(hasActiveTransaction ? session : null);
    if (hasActiveTransaction && session) {
      await session.commitTransaction();
    }
    return result;
  } catch (err) {
    if (hasActiveTransaction && session) {
      try {
        await session.abortTransaction();
      } catch (_) {}
    }
    throw err;
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch (_) {}
    }
  }
}

export async function acceptEmployeeInvitation({ rawToken, password, authUser }) {
  if (!rawToken) {
    throw new ApiError(400, 'Invitation token is required');
  }

  const tokenHash = hashInvitationToken(rawToken);
  const invitation = await EmployeeInvitation.findOne({ tokenHash });
  if (!invitation) {
    throw new ApiError(400, 'Invalid or expired setup token');
  }

  if (invitation.status === 'REVOKED') {
    throw new ApiError(400, 'This invitation has been revoked. Please contact your administrator.');
  }
  if (invitation.status === 'ACCEPTED') {
    throw new ApiError(400, 'This invitation has already been accepted.');
  }

  const now = new Date();
  if (invitation.expiresAt < now || invitation.status === 'EXPIRED') {
    if (invitation.status !== 'EXPIRED') {
      invitation.status = 'EXPIRED';
      await invitation.save();
    }
    throw new ApiError(400, 'This invitation has expired. Please ask your administrator to regenerate it.');
  }

  let user = await User.findOne({ email: invitation.emailNormalized });

  // CASE B: Existing Active User
  if (user && user.status === 'ACTIVE') {
    if (!authUser || !authUser.userId) {
      throw new ApiError(401, 'Authentication required to accept invitation for an existing active account. Please sign in first.');
    }
    if (authUser.email.toLowerCase() !== invitation.emailNormalized) {
      throw new ApiError(403, 'Authenticated user email does not match invitation email');
    }

    // Check if user already has everything in this org/project
    const [existingOrgMember, existingProjMember, existingEmpProfile] = await Promise.all([
      OrganizationMember.findOne({ organizationId: invitation.organizationId, userId: user._id, status: 'ACTIVE' }),
      ProjectMember.findOne({ projectId: invitation.projectId, userId: user._id, status: 'ACTIVE' }),
      EmployeeProfile.findOne({ organizationId: invitation.organizationId, userId: user._id, status: 'ACTIVE' })
    ]);

    if (existingOrgMember && existingProjMember && existingEmpProfile) {
      throw new ApiError(409, 'User already has active membership and employee profile in this organization and project');
    }

    let createdOrgMember = null;
    let createdProjMember = null;
    let createdEmpProfile = null;

    return await executeAtomically(async (session) => {
      const opts = session ? { session } : {};

      try {
        // 1. OrganizationMember
        if (!existingOrgMember) {
          const res = await OrganizationMember.create([{
            organizationId: invitation.organizationId,
            userId: user._id,
            organizationRole: invitation.organizationRole,
            status: 'ACTIVE'
          }], opts);
          createdOrgMember = res[0];
        }

        // 2. ProjectMember
        if (!existingProjMember) {
          const res = await ProjectMember.create([{
            projectId: invitation.projectId,
            userId: user._id,
            role: invitation.projectRole,
            status: 'ACTIVE'
          }], opts);
          createdProjMember = res[0];
        }

        // 3. EmployeeProfile
        if (!existingEmpProfile) {
          let finalCode = invitation.employeeCode;
          if (!finalCode) {
            finalCode = await generateNextEmployeeCode(invitation.organizationId);
          }
          const res = await EmployeeProfile.create([{
            organizationId: invitation.organizationId,
            userId: user._id,
            employeeCode: finalCode,
            displayName: invitation.displayName || user.displayName,
            phone: invitation.phone || undefined,
            designation: invitation.designation || undefined,
            department: invitation.department || undefined,
            status: 'ACTIVE',
            primaryTeamId: undefined,
            createdBy: invitation.invitedByUserId
          }], opts);
          createdEmpProfile = res[0];
        }

        // 4. Mark Invitation ACCEPTED
        invitation.status = 'ACCEPTED';
        invitation.acceptedAt = new Date();
        invitation.acceptedByUserId = user._id;
        if (session) {
          await invitation.save(opts);
        } else {
          await invitation.save();
        }

        return {
          success: true,
          message: 'Invitation accepted successfully',
          email: user.email,
          organizationId: invitation.organizationId,
          projectId: invitation.projectId
        };
      } catch (err) {
        // Non-transaction compensation rollback
        if (!session) {
          if (createdEmpProfile) await EmployeeProfile.deleteOne({ _id: createdEmpProfile._id });
          if (createdProjMember) await ProjectMember.deleteOne({ _id: createdProjMember._id });
          if (createdOrgMember) await OrganizationMember.deleteOne({ _id: createdOrgMember._id });
        }
        throw err;
      }
    });
  }

  // CASE A: New User / Invited User
  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new ApiError(400, 'Password must be at least 6 characters long');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  let isNewUserCreated = false;
  let createdOrgMember = null;
  let createdProjMember = null;
  let createdEmpProfile = null;

  return await executeAtomically(async (session) => {
    const opts = session ? { session } : {};

    try {
      // 1. User creation or activation
      if (!user) {
        const createdUsers = await User.create([{
          email: invitation.emailNormalized,
          displayName: invitation.displayName,
          passwordHash,
          status: 'ACTIVE'
        }], opts);
        user = createdUsers[0];
        isNewUserCreated = true;
      } else {
        user.passwordHash = passwordHash;
        user.displayName = invitation.displayName || user.displayName;
        user.status = 'ACTIVE';
        user.setupToken = undefined;
        user.setupTokenExpires = undefined;
        if (session) {
          await user.save(opts);
        } else {
          await user.save();
        }
      }

      // 2. OrganizationMember
      const orgQuery = OrganizationMember.findOne({
        organizationId: invitation.organizationId,
        userId: user._id
      });
      if (session) orgQuery.session(session);
      const orgMemberExists = await orgQuery;

      if (!orgMemberExists) {
        const res = await OrganizationMember.create([{
          organizationId: invitation.organizationId,
          userId: user._id,
          organizationRole: invitation.organizationRole,
          status: 'ACTIVE'
        }], opts);
        createdOrgMember = res[0];
      }

      // 3. ProjectMember
      const projQuery = ProjectMember.findOne({
        projectId: invitation.projectId,
        userId: user._id
      });
      if (session) projQuery.session(session);
      const projMemberExists = await projQuery;

      if (!projMemberExists) {
        const res = await ProjectMember.create([{
          projectId: invitation.projectId,
          userId: user._id,
          role: invitation.projectRole,
          status: 'ACTIVE'
        }], opts);
        createdProjMember = res[0];
      }

      // 4. EmployeeProfile
      const empQuery = EmployeeProfile.findOne({
        organizationId: invitation.organizationId,
        userId: user._id
      });
      if (session) empQuery.session(session);
      const empProfileExists = await empQuery;

      if (!empProfileExists) {
        let finalCode = invitation.employeeCode;
        if (!finalCode) {
          finalCode = await generateNextEmployeeCode(invitation.organizationId);
        }
        const res = await EmployeeProfile.create([{
          organizationId: invitation.organizationId,
          userId: user._id,
          employeeCode: finalCode,
          displayName: invitation.displayName,
          phone: invitation.phone || undefined,
          designation: invitation.designation || undefined,
          department: invitation.department || undefined,
          status: 'ACTIVE',
          primaryTeamId: undefined,
          createdBy: invitation.invitedByUserId
        }], opts);
        createdEmpProfile = res[0];
      }

      // 5. Mark Invitation ACCEPTED
      invitation.status = 'ACCEPTED';
      invitation.acceptedAt = new Date();
      invitation.acceptedByUserId = user._id;
      if (session) {
        await invitation.save(opts);
      } else {
        await invitation.save();
      }

      return {
        success: true,
        message: 'Account activated and invitation accepted successfully',
        email: user.email,
        organizationId: invitation.organizationId,
        projectId: invitation.projectId
      };
    } catch (err) {
      // Non-transaction compensation rollback
      if (!session) {
        if (createdEmpProfile) await EmployeeProfile.deleteOne({ _id: createdEmpProfile._id });
        if (createdProjMember) await ProjectMember.deleteOne({ _id: createdProjMember._id });
        if (createdOrgMember) await OrganizationMember.deleteOne({ _id: createdOrgMember._id });
        if (isNewUserCreated && user) await User.deleteOne({ _id: user._id });
      }
      throw err;
    }
  });
}
