/**
 * N-of-M multi-instrument verification evaluator.
 * Evaluates whether at least N members of an M-member instrument group satisfy a threshold criterion.
 * Preserves individual member identities without pre-averaging.
 */

/**
 * Evaluates whether a numerical value satisfies a condition.
 * @param {number} value
 * @param {string} operator - '>', '>=', '<', '<='
 * @param {number} threshold
 * @returns {boolean}
 */
export function testCondition(value, operator, threshold) {
  const v = Number(value);
  const t = Number(threshold);

  if (Number.isNaN(v) || Number.isNaN(t)) return false;

  switch (operator) {
    case '>': return v > t;
    case '>=': return v >= t;
    case '<': return v < t;
    case '<=': return v <= t;
    default: return false;
  }
}

/**
 * Evaluates N-of-M criteria on a group of instrument series.
 *
 * @param {Object} options
 * @param {Array<{ instrumentId: string, instrumentCode: string, instrumentName: string, unit?: string, readings: Array<{ observedAt: Date|string, value: number, quality: string }> }>} options.members
 * @param {number} options.requiredCount - N (minimum number of passing members required)
 * @param {string} options.operator - '>', '>=', '<', '<='
 * @param {number} options.threshold - Threshold numeric value
 * @param {string[]} [options.qualityFilter=['VALID']] - Allowed quality values
 * @returns {Object} Detailed N-of-M evaluation result
 */
export function evaluateNofM({
  members = [],
  requiredCount = 1,
  operator = '>=',
  threshold = 0,
  qualityFilter = ['VALID']
}) {
  const qualitySet = new Set(qualityFilter);
  const totalMembers = members.length;
  const N = Math.max(1, Math.min(Number(requiredCount) || 1, totalMembers || 1));
  const thresh = Number(threshold) || 0;

  const memberEvaluations = [];
  let confirmedCount = 0;

  for (const m of members) {
    // 1. Filter valid readings chronologically descending to get most recent valid value
    const sorted = [...(m.readings || [])]
      .filter(r => r.value !== null && r.value !== undefined && !Number.isNaN(Number(r.value)))
      .filter(r => !qualityFilter.length || qualitySet.has(r.quality))
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());

    const latest = sorted[0] || null;

    if (!latest) {
      memberEvaluations.push({
        instrumentId: m.instrumentId,
        instrumentCode: m.instrumentCode || '—',
        instrumentName: m.instrumentName || '—',
        latestValue: null,
        unit: m.unit || '',
        observedAt: null,
        passed: false,
        status: 'NO_DATA',
        conditionText: `${m.instrumentCode}: No valid data (Threshold: ${operator} ${thresh})`
      });
      continue;
    }

    const val = Number(latest.value);
    const passed = testCondition(val, operator, thresh);
    if (passed) confirmedCount++;

    memberEvaluations.push({
      instrumentId: m.instrumentId,
      instrumentCode: m.instrumentCode || '—',
      instrumentName: m.instrumentName || '—',
      latestValue: val,
      unit: m.unit || '',
      observedAt: new Date(latest.observedAt).toISOString(),
      passed,
      status: passed ? 'PASS' : 'FAIL',
      conditionText: `${m.instrumentCode} = ${val} ${m.unit || ''} (${operator} ${thresh}) → ${passed ? 'PASS' : 'FAIL'}`
    });
  }

  const passedOverall = confirmedCount >= N;

  return {
    requiredCount: N,
    totalMembers,
    confirmedCount,
    passed: passedOverall,
    status: passedOverall ? 'PASS' : 'FAIL',
    ratio: `${confirmedCount} / ${totalMembers}`,
    operator,
    threshold: thresh,
    memberEvaluations,
    summary: `Confirmed: ${confirmedCount} of ${totalMembers} (Required: ${N}) → ${passedOverall ? 'PASS' : 'FAIL'}`
  };
}

