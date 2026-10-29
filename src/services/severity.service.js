import { EngineeringSeverityRule } from '../models/index.js';

/**
 * Resolves the single applicable active rule according to deterministic precedence:
 * 1. Instrument-specific active rule (if instrumentId configured)
 * 2. Project-level catalog-specific rule (if catalogCode configured)
 * 3. Project-level parameter rule (generic for parameter across project)
 * 4. null (NO_RULE)
 */
export async function resolveApplicableRule({ projectId, organizationId = null, instrumentId, catalogCode, parameterCode }) {
  if (!projectId || !parameterCode) return null;
  const orgFilter = organizationId ? { organizationId } : {};

  // 1. Instrument-specific active rule
  if (instrumentId) {
    const instRule = await EngineeringSeverityRule.findOne({
      projectId,
      ...orgFilter,
      instrumentId,
      parameterCode,
      status: 'ACTIVE'
    }).lean();
    if (instRule) return instRule;
  }

  // 2. Project-level catalog-specific rule
  if (catalogCode) {
    const catRule = await EngineeringSeverityRule.findOne({
      projectId,
      ...orgFilter,
      catalogCode,
      parameterCode,
      instrumentId: null,
      status: 'ACTIVE'
    }).lean();
    if (catRule) return catRule;
  }

  // 3. Project-level parameter rule
  const paramRule = await EngineeringSeverityRule.findOne({
    projectId,
    ...orgFilter,
    parameterCode,
    catalogCode: null,
    instrumentId: null,
    status: 'ACTIVE'
  }).lean();

  return paramRule || null;
}

/**
 * Evaluates geotechnical/engineering severity for a given measurement.
 * S-level means ENGINEERING / GEOTECHNICAL SEVERITY ONLY.
 * Completely separate from H-level (health), Quality (validity), and Connectivity.
 *
 * @param {Object} params
 * @param {Object} [params.instrument]
 * @param {Object} [params.channel]
 * @param {Object} params.derivedReading
 * @param {string} [params.quality]
 * @param {Object} [params.applicableRule]
 * @returns {Object} Severity result
 */
export function evaluateSeverity({
  instrument = null,
  channel = null,
  derivedReading,
  quality = null,
  applicableRule = null
}) {
  const readingQuality = quality || derivedReading?.quality || 'VALID';

  // 1. Quality Gating: Invalid measurement must NOT generate engineering severity
  if (readingQuality === 'INVALID') {
    return {
      evaluated: false,
      level: 'NOT_EVALUATED',
      reason: 'QUALITY_NOT_VALID',
      ruleId: applicableRule?._id || null,
      ruleVersion: applicableRule?.version || null,
      evaluatedAt: new Date()
    };
  }

  // 2. Rule Gating: If no approved active rule exists, NOT_EVALUATED
  if (!applicableRule) {
    return {
      evaluated: false,
      level: 'NOT_EVALUATED',
      reason: 'NO_RULE',
      ruleId: null,
      ruleVersion: null,
      evaluatedAt: new Date()
    };
  }

  // 3. Unit Validation: Rule unit must be compatible with reading/channel unit
  const readingUnit = (derivedReading?.unit || channel?.engineeringUnit || channel?.rawUnit || '').trim().toLowerCase();
  const ruleUnit = (applicableRule.unit || '').trim().toLowerCase();
  if (!readingUnit || !ruleUnit || readingUnit !== ruleUnit) {
    return {
      evaluated: false,
      level: 'NOT_EVALUATED',
      reason: 'UNIT_MISMATCH',
      ruleId: applicableRule._id,
      ruleVersion: applicableRule.version,
      evaluatedAt: new Date()
    };
  }

  // 4. Metric Extraction & Dependency Gating
  let metricValue = null;
  const metric = applicableRule.metric;

  if (metric === 'engineeringValue') {
    if (derivedReading?.value === undefined || derivedReading?.value === null || !Number.isFinite(Number(derivedReading.value))) {
      return {
        evaluated: false,
        level: 'NOT_EVALUATED',
        reason: 'VALUE_UNAVAILABLE',
        ruleId: applicableRule._id,
        ruleVersion: applicableRule.version,
        evaluatedAt: new Date()
      };
    }
    metricValue = Number(derivedReading.value);
  } else if (metric === 'deltaFromBaseline') {
    // Requires valid configured baseline and baseline-relative delta
    const hasConfiguredBaseline = channel?.baseline?.configured === true;
    const hasDelta = derivedReading?.deltaFromBaseline !== undefined &&
                     derivedReading?.deltaFromBaseline !== null &&
                     Number.isFinite(Number(derivedReading.deltaFromBaseline));

    if (!hasConfiguredBaseline || !hasDelta) {
      return {
        evaluated: false,
        level: 'NOT_EVALUATED',
        reason: 'BASELINE_UNAVAILABLE',
        ruleId: applicableRule._id,
        ruleVersion: applicableRule.version,
        evaluatedAt: new Date()
      };
    }
    metricValue = Number(derivedReading.deltaFromBaseline);
  } else if (metric === 'ratePerHour') {
    // Requires valid rate derived from history
    const hasRate = derivedReading?.ratePerHour !== undefined &&
                    derivedReading?.ratePerHour !== null &&
                    Number.isFinite(Number(derivedReading.ratePerHour));

    if (!hasRate) {
      return {
        evaluated: false,
        level: 'NOT_EVALUATED',
        reason: 'RATE_UNAVAILABLE',
        ruleId: applicableRule._id,
        ruleVersion: applicableRule.version,
        evaluatedAt: new Date()
      };
    }
    metricValue = Number(derivedReading.ratePerHour);
  } else {
    return {
      evaluated: false,
      level: 'NOT_EVALUATED',
      reason: 'UNSUPPORTED_METRIC',
      ruleId: applicableRule._id,
      ruleVersion: applicableRule.version,
      evaluatedAt: new Date()
    };
  }

  // 5. Evaluation Mode (INCREASING, DECREASING, ABSOLUTE)
  let evaluatedValue = metricValue;
  if (applicableRule.mode === 'ABSOLUTE') {
    evaluatedValue = Math.abs(metricValue);
  }

  // 6. Monotonic Threshold Bands Evaluation
  const thresholds = applicableRule.thresholds || {};
  const s1 = (thresholds.s1 !== null && thresholds.s1 !== undefined) ? Number(thresholds.s1) : null;
  const s2 = (thresholds.s2 !== null && thresholds.s2 !== undefined) ? Number(thresholds.s2) : null;
  const s3 = (thresholds.s3 !== null && thresholds.s3 !== undefined) ? Number(thresholds.s3) : null;
  const s4 = (thresholds.s4 !== null && thresholds.s4 !== undefined) ? Number(thresholds.s4) : null;

  let level = 'S0';

  if (applicableRule.mode === 'INCREASING' || applicableRule.mode === 'ABSOLUTE') {
    if (s4 !== null && evaluatedValue >= s4) {
      level = 'S4';
    } else if (s3 !== null && evaluatedValue >= s3) {
      level = 'S3';
    } else if (s2 !== null && evaluatedValue >= s2) {
      level = 'S2';
    } else if (s1 !== null && evaluatedValue >= s1) {
      level = 'S1';
    } else {
      level = 'S0';
    }
  } else if (applicableRule.mode === 'DECREASING') {
    if (s4 !== null && evaluatedValue <= s4) {
      level = 'S4';
    } else if (s3 !== null && evaluatedValue <= s3) {
      level = 'S3';
    } else if (s2 !== null && evaluatedValue <= s2) {
      level = 'S2';
    } else if (s1 !== null && evaluatedValue <= s1) {
      level = 'S1';
    } else {
      level = 'S0';
    }
  }

  return {
    evaluated: true,
    level,
    ruleId: applicableRule._id,
    ruleVersion: applicableRule.version || 1,
    metric: applicableRule.metric,
    evaluatedValue,
    unit: applicableRule.unit,
    evaluatedAt: new Date(),
    reason: null
  };
}
