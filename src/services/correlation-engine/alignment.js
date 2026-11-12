/**
 * Time-series timestamp alignment and resampling utility.
 * Synchronizes measurements from multiple instruments sampling at asynchronous intervals.
 */

/**
 * Determines an appropriate bucket size in milliseconds based on the time span
 * and native sample cadence of the input series.
 * @param {number} durationMs - Total time duration in milliseconds
 * @param {Array} [seriesA=[]] - First input series
 * @param {Array} [seriesB=[]] - Second input series
 * @returns {number} Bucket size in milliseconds
 */
export function determineBucketSizeMs(durationMs, seriesA = [], seriesB = []) {
  function getMedianCadence(series) {
    if (!series || series.length < 2) return null;
    const diffs = [];
    for (let i = 1; i < Math.min(series.length, 30); i++) {
      const dt = Math.abs(new Date(series[i].observedAt).getTime() - new Date(series[i - 1].observedAt).getTime());
      if (dt > 1000) diffs.push(dt);
    }
    if (!diffs.length) return null;
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)];
  }

  const cadA = getMedianCadence(seriesA);
  const cadB = getMedianCadence(seriesB);
  const maxCadence = Math.max(cadA || 0, cadB || 0);

  const ONE_HOUR = 3600 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;

  // If native sampling cadence is hourly or greater, bucket size must accommodate the cadence
  if (maxCadence >= 45 * 60 * 1000) {
    return Math.max(ONE_HOUR, Math.ceil(maxCadence / ONE_HOUR) * ONE_HOUR);
  }

  if (durationMs <= ONE_DAY) {
    // 24 hours or less: use native cadence or default to 30 min / 15 min
    return maxCadence ? Math.max(15 * 60 * 1000, maxCadence) : 30 * 60 * 1000;
  } else if (durationMs <= 7 * ONE_DAY) {
    // 7 days or less: 1-hour buckets
    return ONE_HOUR;
  } else if (durationMs <= 30 * ONE_DAY) {
    // 30 days or less: 2-hour buckets
    return 2 * ONE_HOUR;
  } else {
    // > 30 days: 6-hour buckets
    return 6 * ONE_HOUR;
  }
}

/**
 * Groups raw readings into time buckets and averages readings within each bucket.
 * @param {Array<{observedAt: Date|string|number, value: number, quality: string}>} readings
 * @param {number} bucketSizeMs
 * @param {string[]} allowedQualities
 * @returns {Map<number, { count: number, sum: number, avg: number, quality: string }>}
 */
function bucketSeries(readings, bucketSizeMs, allowedQualities = ['VALID']) {
  const qualitySet = new Set(allowedQualities);
  const buckets = new Map();

  for (const r of readings) {
    if (r.value === null || r.value === undefined || Number.isNaN(Number(r.value))) continue;
    if (allowedQualities.length > 0 && r.quality && !qualitySet.has(r.quality)) continue;

    const t = new Date(r.observedAt).getTime();
    if (Number.isNaN(t)) continue;

    // Floor timestamp to bucket start
    const bucketTime = Math.floor(t / bucketSizeMs) * bucketSizeMs;

    if (!buckets.has(bucketTime)) {
      buckets.set(bucketTime, { count: 0, sum: 0, avg: 0, quality: r.quality || 'VALID' });
    }

    const b = buckets.get(bucketTime);
    b.count += 1;
    b.sum += Number(r.value);
    b.avg = b.sum / b.count;
  }

  return buckets;
}

/**
 * Aligns two time series onto a synchronized uniform time grid.
 * Respects quality filters and generates detailed alignment diagnostics.
 *
 * @param {Object} options
 * @param {Array} options.seriesA - Readings for Input A [{ observedAt, value, quality }]
 * @param {Array} options.seriesB - Readings for Input B [{ observedAt, value, quality }]
 * @param {Date|string} options.startAt - Analysis window start
 * @param {Date|string} options.endAt - Analysis window end
 * @param {string[]} [options.qualityFilter] - Allowed qualities (default ['VALID'])
 * @param {number} [options.lagOffsetMs=0] - Shift to apply to Series B (tB -> tB - lagOffsetMs)
 * @returns {Object} Aligned data and diagnostics
 */
export function alignTimeSeries({
  seriesA = [],
  seriesB = [],
  startAt,
  endAt,
  qualityFilter = ['VALID'],
  lagOffsetMs = 0
}) {
  const startTime = new Date(startAt).getTime();
  const endTime = new Date(endAt).getTime();
  const durationMs = Math.max(endTime - startTime, 3600 * 1000);
  const bucketSizeMs = determineBucketSizeMs(durationMs, seriesA, seriesB);

  // Apply lag offset to seriesB if provided:
  // If B responds tau hours AFTER A (lagOffsetMs > 0), an event in B at (t + tau) corresponds to event in A at t.
  // Therefore, shifted B timestamp = t_B - lagOffsetMs.
  const shiftedSeriesB = lagOffsetMs === 0
    ? seriesB
    : seriesB.map(r => ({
        ...r,
        observedAt: new Date(new Date(r.observedAt).getTime() - lagOffsetMs)
      }));

  const bucketsA = bucketSeries(seriesA, bucketSizeMs, qualityFilter);
  const bucketsB = bucketSeries(shiftedSeriesB, bucketSizeMs, qualityFilter);

  // Find intersection of bucket keys within [startTime, endTime]
  const allBucketTimes = new Set([...bucketsA.keys(), ...bucketsB.keys()]);
  const sortedTimes = Array.from(allBucketTimes).sort((a, b) => a - b);

  const alignedTimestamps = [];
  const alignedA = [];
  const alignedB = [];

  let matchedBuckets = 0;
  let discardedA = 0;
  let discardedB = 0;

  for (const t of sortedTimes) {
    if (t < startTime || t > endTime) continue;

    const hasA = bucketsA.has(t);
    const hasB = bucketsB.has(t);

    if (hasA && hasB) {
      matchedBuckets++;
      alignedTimestamps.push(new Date(t).toISOString());
      alignedA.push(Number(bucketsA.get(t).avg.toFixed(4)));
      alignedB.push(Number(bucketsB.get(t).avg.toFixed(4)));
    } else if (hasA && !hasB) {
      discardedA += bucketsA.get(t).count;
    } else if (!hasA && hasB) {
      discardedB += bucketsB.get(t).count;
    }
  }

  const qualitySet = new Set(qualityFilter);
  const validCountA = seriesA.filter(r => !qualityFilter.length || qualitySet.has(r.quality)).length;
  const validCountB = seriesB.filter(r => !qualityFilter.length || qualitySet.has(r.quality)).length;

  return {
    alignedA,
    alignedB,
    timestamps: alignedTimestamps,
    diagnostics: {
      sourceSamplesA: seriesA.length,
      sourceSamplesB: seriesB.length,
      qualityFilteredA: validCountA,
      qualityFilteredB: validCountB,
      alignedSamples: matchedBuckets,
      discardedSamplesA: discardedA,
      discardedSamplesB: discardedB,
      bucketDurationMinutes: Math.round(bucketSizeMs / (60 * 1000)),
      lagOffsetHours: Number((lagOffsetMs / (3600 * 1000)).toFixed(2))
    }
  };
}
