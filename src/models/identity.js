import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const organizationSchema = new Schema({
  name: { type: String, required: true },
  code: { type: String, required: true, unique: true, uppercase: true },
  timezone: { type: String, default: 'Asia/Kolkata' },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  displayName: { type: String, required: true },
  passwordHash: { type: String, required: true },
  status: { type: String, enum: ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'], default: 'ACTIVE' },
  lastActiveAt: Date,
  identityProviderRef: String
}, { timestamps: true });

const organizationMemberSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  organizationRole: { type: String, enum: ['ADMINISTRATOR', 'ENGINEER', 'OPERATOR', 'VIEWER'], required: true },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' }
}, { timestamps: true });
organizationMemberSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

const projectMemberSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['ADMINISTRATOR', 'ENGINEER', 'OPERATOR', 'VIEWER'], required: true },
  permissionOverrides: { type: [String], default: [] },
  activeFrom: { type: Date, default: Date.now },
  activeTo: Date,
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' }
}, { timestamps: true });
projectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });

const serviceAccountSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  allowedProjects: [{ type: Schema.Types.ObjectId, ref: 'Project' }],
  capabilityScope: { type: [String], default: [] },
  credentialHash: { type: String, required: true },
  credentialVersion: { type: Number, default: 1 },
  lastUsedAt: Date
}, { timestamps: true });

export const Organization = model('Organization', organizationSchema);
export const User = model('User', userSchema);
export const OrganizationMember = model('OrganizationMember', organizationMemberSchema);
export const ProjectMember = model('ProjectMember', projectMemberSchema);
export const ServiceAccount = model('ServiceAccount', serviceAccountSchema);
