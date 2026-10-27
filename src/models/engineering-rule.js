import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const engineeringSeverityRuleSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  code: { type: String, required: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },

  // Scope
  parameterCode: { type: String, required: true, index: true },
  catalogCode: { type: String, default: null },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', default: null, index: true },

  // Evaluation Metric
  metric: {
    type: String,
    enum: ['engineeringValue', 'deltaFromBaseline', 'ratePerHour'],
    required: true
  },

  // Evaluation Mode
  mode: {
    type: String,
    enum: ['INCREASING', 'DECREASING', 'ABSOLUTE'],
    required: true
  },

  // Engineering Unit
  unit: { type: String, required: true },

  // Monotonic Severity Thresholds / Bands
  thresholds: {
    s1: { type: Number, default: null },
    s2: { type: Number, default: null },
    s3: { type: Number, default: null },
    s4: { type: Number, default: null }
  },

  // Auditable Versioning
  version: { type: Number, default: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

engineeringSeverityRuleSchema.index({ projectId: 1, parameterCode: 1, status: 1 });
engineeringSeverityRuleSchema.index({ projectId: 1, instrumentId: 1, parameterCode: 1, status: 1 });

/**
 * Validates that rule thresholds satisfy monotonic ordering rules:
 * - INCREASING / ABSOLUTE: defined thresholds must satisfy s1 < s2 < s3 < s4 (and >= 0 for ABSOLUTE).
 * - DECREASING: defined thresholds must satisfy s1 > s2 > s3 > s4.
 * At least one threshold must be configured.
 */
export function validateRuleThresholds({ mode, thresholds }) {
  if (!thresholds || typeof thresholds !== 'object') {
    return { valid: false, message: 'Thresholds configuration is required' };
  }

  const { s1, s2, s3, s4 } = thresholds;
  const defined = [];
  if (s1 !== undefined && s1 !== null && Number.isFinite(Number(s1))) defined.push({ key: 's1', val: Number(s1) });
  if (s2 !== undefined && s2 !== null && Number.isFinite(Number(s2))) defined.push({ key: 's2', val: Number(s2) });
  if (s3 !== undefined && s3 !== null && Number.isFinite(Number(s3))) defined.push({ key: 's3', val: Number(s3) });
  if (s4 !== undefined && s4 !== null && Number.isFinite(Number(s4))) defined.push({ key: 's4', val: Number(s4) });

  if (defined.length === 0) {
    return { valid: false, message: 'At least one valid finite threshold (s1, s2, s3, or s4) must be defined' };
  }

  if (mode === 'ABSOLUTE') {
    for (const d of defined) {
      if (d.val < 0) {
        return { valid: false, message: `Threshold ${d.key} must be non-negative for ABSOLUTE mode (${d.val} given)` };
      }
    }
  }

  if (mode === 'INCREASING' || mode === 'ABSOLUTE') {
    for (let i = 0; i < defined.length - 1; i++) {
      if (defined[i].val >= defined[i + 1].val) {
        return {
          valid: false,
          message: `Monotonic ordering violation for ${mode} mode: ${defined[i].key} (${defined[i].val}) must be strictly less than ${defined[i + 1].key} (${defined[i + 1].val})`
        };
      }
    }
  } else if (mode === 'DECREASING') {
    for (let i = 0; i < defined.length - 1; i++) {
      if (defined[i].val <= defined[i + 1].val) {
        return {
          valid: false,
          message: `Monotonic ordering violation for DECREASING mode: ${defined[i].key} (${defined[i].val}) must be strictly greater than ${defined[i + 1].key} (${defined[i + 1].val})`
        };
      }
    }
  } else {
    return { valid: false, message: `Unsupported mode: ${mode}. Must be INCREASING, DECREASING, or ABSOLUTE` };
  }

  return { valid: true };
}

export const EngineeringSeverityRule = model('EngineeringSeverityRule', engineeringSeverityRuleSchema);
