import mongoose from 'mongoose';
const { Schema, model } = mongoose;

/**
 * AlarmTriggerPolicy Schema (Phase C6C)
 * Connects centralized Engineering Severity evaluation to Canonical Alarms
 * through explicit, project-scoped trigger rules.
 */
const alarmTriggerPolicySchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true },
  code: { type: String },

  category: {
    type: String,
    enum: [
      'ENGINEERING_SEVERITY',
      'MONITORING_HEALTH',
      'MEASUREMENT_QUALITY',
      'DEVICE_CONNECTIVITY',
      'GATEWAY_CONNECTIVITY'
    ],
    default: 'ENGINEERING_SEVERITY',
    required: true,
    index: true
  },

  // Deterministic Scope Precedence:
  // 1. INSTRUMENT (+ parameterCode)
  // 2. CATALOGUE (+ parameterCode)
  // 3. PARAMETER (project-wide parameterCode)
  // 4. PROJECT (all parameters)
  scope: {
    type: String,
    enum: ['INSTRUMENT', 'CATALOGUE', 'PARAMETER', 'PROJECT'],
    default: 'PROJECT',
    required: true,
    index: true
  },

  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', default: null, index: true },
  catalogCode: { type: String, default: null },
  parameterCode: { type: String, default: null, index: true },

  // Qualifying severity levels that trigger canonical alarms
  triggerLevels: {
    type: [String],
    enum: ['S1', 'S2', 'S3', 'S4'],
    default: ['S2', 'S3', 'S4'],
    required: true
  },

  // Lifecycle state: New projects default to INACTIVE (no automatic alarms)
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'INACTIVE',
    index: true
  },

  version: { type: Number, default: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

alarmTriggerPolicySchema.index({ projectId: 1, status: 1 });
alarmTriggerPolicySchema.index({ projectId: 1, category: 1, status: 1 });
alarmTriggerPolicySchema.index({ projectId: 1, instrumentId: 1, parameterCode: 1, status: 1 });
alarmTriggerPolicySchema.index({ projectId: 1, parameterCode: 1, status: 1 });

export const AlarmTriggerPolicy = model('AlarmTriggerPolicy', alarmTriggerPolicySchema);
