/**
 * Correlation Service.
 * Canonical entry point for correlation validation and workflow execution.
 */

export { validateGraph } from './correlation-engine/validation.js';
export { executeBacktest, topologicalSort } from './correlation-engine/runner.js';
export { alignTimeSeries } from './correlation-engine/alignment.js';
export { calculatePearson, getRelationshipDescriptor, evaluateCorrelation, formatLagSemantics } from './correlation-engine/relationship.js';
export { evaluateNofM, testCondition } from './correlation-engine/nofm.js';
