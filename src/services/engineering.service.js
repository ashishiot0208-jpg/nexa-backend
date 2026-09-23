import { DerivedReading } from '../models/index.js';

export async function deriveChannelReading({ rawReading, channel }) {
  const previous = await DerivedReading.findOne({ channelId: channel._id }).sort({ observedAt: -1 }).lean();
  const scale = channel.calibration?.scale ?? 1;
  const offset = channel.calibration?.offset ?? 0;
  const baseline = channel.baseline?.value ?? 0;
  const value = Number(rawReading.rawValue) * scale + offset;
  const deltaFromBaseline = value - baseline;
  let ratePerHour = null;
  let accelerationPerHour2 = null;
  if (previous && rawReading.sampleTime > previous.observedAt) {
    const dt = (rawReading.sampleTime - previous.observedAt) / 3600000;
    ratePerHour = dt > 0 ? (value - previous.value) / dt : null;
    if (Number.isFinite(previous.ratePerHour) && Number.isFinite(ratePerHour)) accelerationPerHour2 = (ratePerHour - previous.ratePerHour) / dt;
  }
  return DerivedReading.create({
    organizationId: rawReading.organizationId,
    projectId: rawReading.projectId,
    instrumentId: channel.instrumentId,
    channelId: channel._id,
    rawReadingId: rawReading._id,
    parameterCode: channel.parameterCode,
    observedAt: rawReading.sampleTime,
    value,
    unit: channel.engineeringUnit || channel.rawUnit,
    deltaFromBaseline,
    ratePerHour,
    accelerationPerHour2,
    quality: rawReading.quality,
    qualityReasons: rawReading.qualityReasons,
    calibrationVersion: channel.calibration?.version || 1,
    baselineVersion: channel.baseline?.version || 1,
    formulaVersion: '1.0',
    revision: 1,
    sourceReadingIds: [rawReading._id]
  });
}

export async function deriveCrossChannelMetrics(readings) {
  const byInstrument = new Map();
  for (const r of readings) {
    const key = r.instrumentId.toString();
    if (!byInstrument.has(key)) byInstrument.set(key, []);
    byInstrument.get(key).push(r);
  }
  const created = [];
  for (const group of byInstrument.values()) {
    const map = new Map(group.map((r) => [r.parameterCode, r]));
    const pairs = [
      ['tilt_x_deg', 'tilt_y_deg', 'tilt_resultant_deg', 'deg'],
      ['disp_x_mm', 'disp_y_mm', 'disp_resultant_mm', 'mm']
    ];
    for (const [xCode, yCode, outCode, unit] of pairs) {
      const x = map.get(xCode), y = map.get(yCode);
      if (!x || !y) continue;
      const observedAt = x.observedAt > y.observedAt ? x.observedAt : y.observedAt;
      const value = Math.sqrt(x.value ** 2 + y.value ** 2);
      const doc = await DerivedReading.create({
        organizationId: x.organizationId,
        projectId: x.projectId,
        instrumentId: x.instrumentId,
        parameterCode: outCode,
        observedAt,
        value,
        unit,
        quality: (x.quality === 'INVALID' || y.quality === 'INVALID') ? 'INVALID' : (x.quality === 'SUSPECT' || y.quality === 'SUSPECT') ? 'SUSPECT' : 'VALID',
        qualityReasons: [...new Set([...(x.qualityReasons || []), ...(y.qualityReasons || [])])],
        formulaVersion: '1.0',
        sourceReadingIds: [x.rawReadingId, y.rawReadingId].filter(Boolean),
        metadata: { derivedFrom: [xCode, yCode] }
      });
      created.push(doc);
    }
  }
  return created;
}
