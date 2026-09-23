const S = ['S0', 'S1', 'S2', 'S3', 'S4'];
const H = ['H0', 'H1', 'H2', 'H3', 'H4'];
export const severityRank = (v) => Math.max(0, S.indexOf(v));
export const healthRank = (v) => Math.max(0, H.indexOf(v));
export const maxSeverity = (values = []) => values.reduce((a, b) => severityRank(b) > severityRank(a) ? b : a, 'S0');
export const maxHealth = (values = []) => values.reduce((a, b) => healthRank(b) > healthRank(a) ? b : a, 'H0');
export const confidenceBand = (score) => score >= 80 ? 'HIGH' : score >= 60 ? 'MEDIUM' : 'LOW';
