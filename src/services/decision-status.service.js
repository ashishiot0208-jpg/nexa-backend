import { maxHealth, maxSeverity, severityRank } from '../utils/severity.js';

/**
 * Derives operational status (severity, monitoringHealth, confidence, etc)
 * from a list of current decisions.
 *
 * @param {Array} currentDecisions - Array of DecisionSnapshot objects.
 * @returns {Object} Status object with { severity, severityFloor, monitoringHealth, confidence, confidenceBand, primaryReason, decisionId }
 */
export function deriveOperationalStatus(currentDecisions) {
  const severity = maxSeverity(currentDecisions.map((d) => d.severity));
  const severityFloor = maxSeverity(currentDecisions.map((d) => d.severityFloor));
  const monitoringHealth = maxHealth(currentDecisions.map((d) => d.monitoringHealth));
  
  const representative = currentDecisions
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || new Date(b.evaluatedAt) - new Date(a.evaluatedAt))[0];

  let confidence = null;
  let confidenceBand = null;

  if (currentDecisions.length > 0) {
    confidence = Math.min(...currentDecisions.map((d) => d.confidence ?? 100));
    confidenceBand = confidence >= 80 ? 'HIGH' : confidence >= 60 ? 'MEDIUM' : 'LOW';
  }

  return {
    severity,
    severityFloor,
    monitoringHealth,
    confidence,
    confidenceBand,
    primaryReason: representative?.reasonCodes?.[0] || 'NORMAL',
    decisionId: representative?._id || null
  };
}
