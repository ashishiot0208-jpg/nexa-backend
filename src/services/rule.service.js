import { DerivedReading, RuleSet } from '../models/index.js';
import { maxSeverity } from '../utils/severity.js';

function compare(value, op, threshold) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  if (op === '>') return value > threshold;
  if (op === '>=') return value >= threshold;
  if (op === '<') return value < threshold;
  if (op === '<=') return value <= threshold;
  if (op === '==') return value === threshold;
  return false;
}

function selectValue(reading, type) {
  if (type === 'RATE') return reading.ratePerHour;
  if (type === 'ACCELERATION') return reading.accelerationPerHour2;
  if (type === 'DIFFERENTIAL') return reading.deltaFromBaseline;
  return reading.value;
}

export async function evaluateRules({ project, derivedReadings }) {
  if (!project.ruleSetId) return { severityFloor: 'S0', matchedRules: [], ruleSet: null };
  const ruleSet = await RuleSet.findById(project.ruleSetId).lean();
  if (!ruleSet || !['APPROVED', 'ACTIVE'].includes(ruleSet.status)) return { severityFloor: 'S0', matchedRules: [], ruleSet };
  const matchedRules = [];

  for (const rule of ruleSet.rules || []) {
    if (rule.enabled === false) continue;
    if (rule.type === 'COMPOUND') {
      const results = (rule.conditions || []).map((c) => {
        const reading = derivedReadings.find((r) => r.parameterCode === c.parameterCode && r.quality !== 'INVALID');
        return reading ? compare(selectValue(reading, c.valueType || 'ABSOLUTE'), c.operator || '>', Number(c.threshold)) : false;
      });
      const ok = rule.logic === 'ANY' ? results.some(Boolean) : results.every(Boolean);
      if (ok) matchedRules.push({ id: rule.id, name: rule.name, type: rule.type, severity: rule.severity, reasonCode: rule.reasonCode || rule.id, conditions: rule.conditions });
      continue;
    }
    const candidates = derivedReadings.filter((r) => r.parameterCode === rule.parameterCode && r.quality !== 'INVALID');
    const reading = candidates.sort((a, b) => b.observedAt - a.observedAt)[0];
    if (!reading) continue;
    const value = selectValue(reading, rule.type);
    let ok = compare(value, rule.operator || '>', Number(rule.threshold));
    if (ok && Number(rule.persistenceCount) > 1 && reading.channelId) {
      const history = await DerivedReading.find({ channelId: reading.channelId, parameterCode: reading.parameterCode, quality: { $ne: 'INVALID' } }).sort({ observedAt: -1 }).limit(Number(rule.persistenceCount)).lean();
      ok = history.length >= Number(rule.persistenceCount) && history.every((h) => compare(selectValue(h, rule.type), rule.operator || '>', Number(rule.threshold)));
    }
    if (ok) matchedRules.push({
      id: rule.id,
      name: rule.name,
      type: rule.type,
      parameterCode: rule.parameterCode,
      severity: rule.severity,
      reasonCode: rule.reasonCode || rule.id,
      observed: value,
      threshold: Number(rule.threshold),
      operator: rule.operator || '>',
      readingId: reading._id
    });
  }
  return { severityFloor: maxSeverity(matchedRules.map((x) => x.severity)), matchedRules, ruleSet };
}
