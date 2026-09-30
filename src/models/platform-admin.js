import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const platformAdminSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  lastLoginAt: Date
}, { timestamps: true });

const adminAuditSchema = new Schema({
  adminId: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', required: true },
  action: { type: String, required: true },
  targetType: String,
  targetId: Schema.Types.ObjectId,
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

export const PlatformAdmin = model('PlatformAdmin', platformAdminSchema);
export const AdminAudit = model('AdminAudit', adminAuditSchema);
