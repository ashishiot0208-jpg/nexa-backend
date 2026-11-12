/**
 * Relationship and statistical computation engine.
 * Computes Pearson correlation and optimal lag search with explicit temporal direction.
 */

import { alignTimeSeries } from './alignment.js';

/**
 * Calculates standard Pearson correlation coefficient between two aligned numerical arrays.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number|null} Pearson r, or null if insufficient variance or length < 3
 */
export function calculatePearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;

  const x = xs.slice(0, n);
  const y = ys.slice(0, n);

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);
  if (!denominator || Number.isNaN(denominator) || denominator === 0) {
    return null; // Zero variance in signal
  }

  const r = numerator / denominator;
  // Clamp floating-point imprecision to [-1, 1]
  return Math.max(-1, Math.min(1, Number(r.toFixed(4))));
}

/**
 * Centralized descriptive relationship helper.
 * Thresholds:
 *   |r| >= 0.80  Strong
 *   |r| >= 0.60  Moderate
 *   |r| >= 0.30  Weak
 *   otherwise    Very weak / no clear linear relationship
 *
 * @param {number|null} r - Pearson r value
 * @returns {{ strength: string, direction: string, label: string }}
 */
export function getRelationshipDescriptor(r) {
  if (r === null || r === undefined || Number.isNaN(r)) {
    return {
      strength: 'Undefined',
      direction: 'None',
      label: 'Insufficient data / Zero variance'
    };
  }

  const absR = Math.abs(r);
  let strength = 'Very weak';
  let direction = r > 0 ? 'Positive' : r < 0 ? 'Negative' : 'Neutral';

  if (absR >= 0.80) {
    strength = 'Strong';
  } else if (absR >= 0.60) {
    strength = 'Moderate';
  } else if (absR >= 0.30) {
    strength = 'Weak';
  } else {
    return {
      strength: 'Very weak',
      direction,
      label: 'Very weak / no clear linear relationship'
    };
  }

  return {
    strength,
    direction,
    label: `${strength} ${direction}`
  };
}

/**
 * Formats lag semantics into an explicit human-readable sentence.
 * @param {number} lagHours - Signed lag in hours
 * @param {string} labelA - Label for Input A
 * @param {string} labelB - Label for Input B
 * @returns {string} Explicit direction sentence
 */
export function formatLagSemantics(lagHours, labelA = 'Input A', labelB = 'Input B') {
  if (lagHours === 0) {
    return `${labelB} responds simultaneously with ${labelA} (0 h lag).`;
  } else if (lagHours > 0) {
    return `+${lagHours} h: ${labelB} responds approximately ${lagHours} hour${lagHours === 1 ? '' : 's'} after ${labelA}.`;
  } else {
    const absLag = Math.abs(lagHours);
    return `${lagHours} h: ${labelB} leads ${labelA} by approximately ${absLag} hour${absLag === 1 ? '' : 's'}.`;
  }
}

/**
 * Evaluates Pearson correlation with optional dynamic lag search.
 *
 * @param {Object} options
 * @param {Array} options.seriesA - Raw readings for Input A
 * @param {Array} options.seriesB - Raw readings for Input B
 * @param {Date|string} options.startAt - Window start
 * @param {Date|string} options.endAt - Window end
 * @param {boolean} [options.lagSearch=false] - Whether to search across lag offsets
 * @param {number} [options.maxLagHours=24] - Maximum lag search window in hours
 * @param {number} [options.lagStepHours=1] - Lag search step in hours
 * @param {number} [options.minSamples=20] - Minimum aligned samples required
 * @param {string[]} [options.qualityFilter=['VALID']] - Allowed quality values
 * @param {string} [options.labelA='Input A']
 * @param {string} [options.labelB='Input B']
 * @returns {Object} Complete correlation evaluation result
 */
export function evaluateCorrelation({
  seriesA = [],
  seriesB = [],
  startAt,
  endAt,
  lagSearch = false,
  maxLagHours = 24,
  lagStepHours = 1,
  minSamples = 20,
  qualityFilter = ['VALID'],
  labelA = 'Input A',
  labelB = 'Input B'
}) {
  // 1. Evaluate baseline at 0 lag
  const baselineAligned = alignTimeSeries({
    seriesA,
    seriesB,
    startAt,
    endAt,
    qualityFilter,
    lagOffsetMs: 0
  });

  const r0 = calculatePearson(baselineAligned.alignedA, baselineAligned.alignedB);

  // If lag search is OFF, return baseline result
  if (!lagSearch) {
    const alignedCount = baselineAligned.diagnostics.alignedSamples;
    const hasEnoughSamples = alignedCount >= minSamples;
    const validR = hasEnoughSamples ? r0 : null;
    const descriptor = getRelationshipDescriptor(validR);

    return {
      method: 'PEARSON',
      lagSearchPerformed: false,
      r: validR,
      rZeroLag: r0,
      bestLagHours: 0,
      lagSemantics: formatLagSemantics(0, labelA, labelB),
      relationship: descriptor.label,
      strength: descriptor.strength,
      direction: descriptor.direction,
      samples: alignedCount,
      minSamplesRequired: minSamples,
      hasEnoughSamples,
      sampleWarning: hasEnoughSamples ? null : `Aligned samples (${alignedCount}) below minimum required (${minSamples})`,
      diagnostics: baselineAligned.diagnostics,
      alignedTimestamps: baselineAligned.timestamps,
      alignedValuesA: baselineAligned.alignedA,
      alignedValuesB: baselineAligned.alignedB
    };
  }

  // 2. Perform lag search:
  // We scan tau from -maxLagHours to +maxLagHours with step lagStepHours.
  const step = Math.max(1, Number(lagStepHours) || 1);
  const maxLag = Math.max(1, Number(maxLagHours) || 24);

  let bestLagHours = 0;
  let bestR = r0;
  let bestAbsR = r0 !== null ? Math.abs(r0) : -1;
  let bestAlignedResult = baselineAligned;

  const testedLags = [];

  for (let lag = -maxLag; lag <= maxLag; lag += step) {
    const lagOffsetMs = lag * 3600 * 1000;
    const aligned = alignTimeSeries({
      seriesA,
      seriesB,
      startAt,
      endAt,
      qualityFilter,
      lagOffsetMs
    });

    if (aligned.diagnostics.alignedSamples >= minSamples) {
      const candidateR = calculatePearson(aligned.alignedA, aligned.alignedB);
      if (candidateR !== null) {
        testedLags.push({ lagHours: lag, r: candidateR, samples: aligned.diagnostics.alignedSamples });
        if (Math.abs(candidateR) > bestAbsR) {
          bestAbsR = Math.abs(candidateR);
          bestR = candidateR;
          bestLagHours = lag;
          bestAlignedResult = aligned;
        }
      }
    }
  }

  const alignedCount = bestAlignedResult.diagnostics.alignedSamples;
  const hasEnoughSamples = alignedCount >= minSamples;
  const validR = hasEnoughSamples ? bestR : null;
  const descriptor = getRelationshipDescriptor(validR);

  return {
    method: 'PEARSON',
    lagSearchPerformed: true,
    r: validR,
    rZeroLag: r0,
    bestLagHours,
    lagSemantics: formatLagSemantics(bestLagHours, labelA, labelB),
    relationship: descriptor.label,
    strength: descriptor.strength,
    direction: descriptor.direction,
    samples: alignedCount,
    minSamplesRequired: minSamples,
    hasEnoughSamples,
    sampleWarning: hasEnoughSamples ? null : `Aligned samples (${alignedCount}) below minimum required (${minSamples})`,
    testedLagCount: testedLags.length,
    diagnostics: bestAlignedResult.diagnostics,
    alignedTimestamps: bestAlignedResult.timestamps,
    alignedValuesA: bestAlignedResult.alignedA,
    alignedValuesB: bestAlignedResult.alignedB
  };
}

