import mongoose from 'mongoose';
const { Schema, model } = mongoose;

/**
 * Employee Profile
 * Lightweight workforce metadata linked to User and Organization.
 * Does NOT duplicate authentication identity.
 */
const employeeProfileSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employeeCode: { type: String, required: true, uppercase: true, trim: true },
  displayName: { type: String, required: true, trim: true },
  phone: { type: String, trim: true },
  designation: { type: String, trim: true },
  department: { type: String, trim: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  primaryTeamId: { type: Schema.Types.ObjectId, ref: 'Team' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

employeeProfileSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
employeeProfileSchema.index({ organizationId: 1, employeeCode: 1 }, { unique: true });

/**
 * Team
 * Organization-scoped operational or functional team.
 */
const teamSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  teamCode: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  functionLabel: { type: String, trim: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  teamLeadUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

teamSchema.index({ organizationId: 1, teamCode: 1 }, { unique: true });

/**
 * Team Member
 * Association between User and Team within an Organization.
 * Users may belong to multiple Teams.
 */
const teamMemberSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  membershipRole: { type: String, enum: ['LEAD', 'MEMBER'], default: 'MEMBER' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  joinedAt: { type: Date, default: Date.now },
  leftAt: { type: Date },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

teamMemberSchema.index({ teamId: 1, userId: 1 }, { unique: true });
teamMemberSchema.index({ organizationId: 1, userId: 1, status: 1 });

/**
 * Project Team Access
 * Access and permissions granted to a Team for a specific Project.
 */
const projectTeamAccessSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  accessProfile: { type: String, trim: true },
  permissions: { type: [String], default: [] },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

projectTeamAccessSchema.index({ organizationId: 1, projectId: 1, teamId: 1 }, { unique: true });

/**
 * Employee Invitation
 * Client-side invitation model for employee onboarding into an organization and project.
 * Tokens are stored hashed (SHA-256), never raw.
 */
const employeeInvitationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  emailNormalized: { type: String, required: true, lowercase: true, trim: true, index: true },
  displayName: { type: String, required: true, trim: true },
  employeeCode: { type: String, uppercase: true, trim: true },
  designation: { type: String, trim: true },
  department: { type: String, trim: true },
  phone: { type: String, trim: true },
  organizationRole: { type: String, enum: ['ADMINISTRATOR', 'ENGINEER', 'OPERATOR', 'VIEWER'], required: true },
  projectRole: { type: String, enum: ['ADMINISTRATOR', 'ENGINEER', 'OPERATOR', 'VIEWER'], required: true },
  status: { type: String, enum: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'], default: 'PENDING', index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  invitedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  acceptedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  acceptedAt: { type: Date },
  revokedAt: { type: Date }
}, { timestamps: true });

employeeInvitationSchema.index({ organizationId: 1, projectId: 1, emailNormalized: 1 });
employeeInvitationSchema.index({ organizationId: 1, projectId: 1, status: 1 });

export const EmployeeProfile = model('EmployeeProfile', employeeProfileSchema);
export const Team = model('Team', teamSchema);
export const TeamMember = model('TeamMember', teamMemberSchema);
export const ProjectTeamAccess = model('ProjectTeamAccess', projectTeamAccessSchema);
export const EmployeeInvitation = model('EmployeeInvitation', employeeInvitationSchema);

