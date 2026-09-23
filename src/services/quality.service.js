export function evaluateQuality({ rawValue, channel, sampleTime, previousDerived }) {
  const reasons = [];
  let quality = 'VALID';
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return { quality: 'INVALID', reasons: ['MALFORMED_VALUE'] };

  const cfg = channel.qualityConfig || {};
  if (Number.isFinite(cfg.physicalMin) && value < cfg.physicalMin) { quality = 'INVALID'; reasons.push('PHYSICAL_RANGE_LOW'); }
  if (Number.isFinite(cfg.physicalMax) && value > cfg.physicalMax) { quality = 'INVALID'; reasons.push('PHYSICAL_RANGE_HIGH'); }

  const now = Date.now();
  if (sampleTime.getTime() > now + 5 * 60 * 1000) { if (quality !== 'INVALID') quality = 'SUSPECT'; reasons.push('DEVICE_CLOCK_FUTURE'); }

  if (previousDerived && quality !== 'INVALID') {
    const dtHours = Math.max((sampleTime - previousDerived.observedAt) / 3600000, 1 / 3600);
    const engineering = value * (channel.calibration?.scale ?? 1) + (channel.calibration?.offset ?? 0);
    const step = Math.abs(engineering - previousDerived.value);
    if (Number.isFinite(cfg.maxStep) && step > cfg.maxStep) { quality = 'SUSPECT'; reasons.push('SUDDEN_JUMP'); }
    const rate = step / dtHours;
    if (Number.isFinite(cfg.maxRatePerHour) && rate > cfg.maxRatePerHour) { quality = 'SUSPECT'; reasons.push('IMPROBABLE_RATE'); }
  }
  return { quality, reasons };
}
