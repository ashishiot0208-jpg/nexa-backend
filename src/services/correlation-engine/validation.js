/**
 * Graph schema validation and DAG cycle detection for Correlation Workflows.
 */

import crypto from 'node:crypto';

export const SUPPORTED_NODE_TYPES = {
  Instrument: { family: 'DATA', inputs: [], outputs: ['series'] },
  'Instrument Group': { family: 'DATA', inputs: [], outputs: ['group'] },
  Device: { family: 'DATA', inputs: [], outputs: ['series'] },
  Gateway: { family: 'CONTEXT', inputs: [], outputs: ['gatewayContext'] },
  Alarm: { family: 'CONTEXT', inputs: [], outputs: ['alarmContext'] },
  Notification: { family: 'CONTEXT', inputs: [], outputs: ['notificationContext'] },
  Correlation: { family: 'ANALYSIS', inputs: ['seriesA', 'seriesB'], outputs: ['correlationResult'] },
  'N-of-M': { family: 'LOGIC', inputs: ['groupIn'], outputs: ['nofmResult'] },
  Result: { family: 'OUTPUT', inputs: ['correlationIn', 'nofmIn', 'gatewayIn', 'alarmIn', 'notificationIn'], outputs: [] }
};

/**
 * Validates connection port compatibility.
 * Strictly frozen to the approved 8 connections:
 * 1. Instrument -> Correlation
 * 2. Device -> Correlation
 * 3. Instrument Group -> N-of-M
 * 4. Correlation -> Result
 * 5. N-of-M -> Result
 * 6. Gateway -> Result
 * 7. Alarm -> Result
 * 8. Notification -> Result
 *
 * All other connections are explicitly rejected.
 *
 * @param {string} sourceType
 * @param {string} sourcePort
 * @param {string} targetType
 * @param {string} targetPort
 * @returns {boolean}
 */
export function isPortConnectionValid(sourceType, sourcePort, targetType, targetPort) {
  // 1 & 2: Instrument or Device -> Correlation
  if ((sourceType === 'Instrument' || sourceType === 'Device') && (sourcePort === 'series' || sourcePort === 'default')) {
    return targetType === 'Correlation' && (targetPort === 'seriesA' || targetPort === 'seriesB' || targetPort === 'default');
  }

  // 3: Instrument Group -> N-of-M
  if (sourceType === 'Instrument Group' && (sourcePort === 'group' || sourcePort === 'default')) {
    return targetType === 'N-of-M' && (targetPort === 'groupIn' || targetPort === 'default');
  }

  // 4: Correlation -> Result
  if (sourceType === 'Correlation' && (sourcePort === 'correlationResult' || sourcePort === 'default')) {
    return targetType === 'Result' && (targetPort === 'correlationIn' || targetPort === 'default');
  }

  // 5: N-of-M -> Result
  if (sourceType === 'N-of-M' && (sourcePort === 'nofmResult' || sourcePort === 'default')) {
    return targetType === 'Result' && (targetPort === 'nofmIn' || targetPort === 'default');
  }

  // 6: Gateway -> Result
  if (sourceType === 'Gateway' && (sourcePort === 'gatewayContext' || sourcePort === 'default')) {
    return targetType === 'Result' && (targetPort === 'gatewayIn' || targetPort === 'default');
  }

  // 7: Alarm -> Result
  if (sourceType === 'Alarm' && (sourcePort === 'alarmContext' || sourcePort === 'default')) {
    return targetType === 'Result' && (targetPort === 'alarmIn' || targetPort === 'default');
  }

  // 8: Notification -> Result
  if (sourceType === 'Notification' && (sourcePort === 'notificationContext' || sourcePort === 'default')) {
    return targetType === 'Result' && (targetPort === 'notificationIn' || targetPort === 'default');
  }

  return false;
}

/**
 * Validates a CorrelationWorkflow graphJson structure.
 * Checks for:
 * 1. Existence of nodes & edges
 * 2. Node types in SUPPORTED_NODE_TYPES
 * 3. Valid edge endpoint nodes and ports
 * 4. Acyclic DAG (no cycles)
 * 5. Presence of at least one Result node
 *
 * @param {Object} graph - { nodes: [], edges: [] }
 * @returns {{ valid: boolean, errors: string[], checksum: string, warnings: string[] }}
 */
export function validateGraph(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const errors = [];
  const warnings = [];

  if (!nodes.length) {
    errors.push('Graph contains no nodes');
    return { valid: false, errors, warnings, checksum: '' };
  }

  const nodeMap = new Map();
  for (const n of nodes) {
    if (!n.id) {
      errors.push('Node missing required id');
      continue;
    }
    if (nodeMap.has(n.id)) {
      errors.push(`Duplicate node id: ${n.id}`);
    }
    nodeMap.set(n.id, n);

    const typeDef = SUPPORTED_NODE_TYPES[n.type];
    if (!typeDef) {
      errors.push(`Unsupported node type '${n.type}' on node '${n.id}'`);
    }
  }

  // Check Result node presence
  const resultNodes = nodes.filter(n => n.type === 'Result');
  if (resultNodes.length === 0) {
    warnings.push('Graph does not contain a Result node; execution will produce no output evidence');
  }

  // Validate edges
  const targetPortUsage = new Map();
  const correlationInputCounts = new Map();
  const nofmInputCounts = new Map();

  for (const e of edges) {
    const srcId = e.sourceNodeId || e.source;
    const tgtId = e.targetNodeId || e.target;
    const src = nodeMap.get(srcId);
    const tgt = nodeMap.get(tgtId);

    if (!src) {
      errors.push(`Edge connects from non-existent source node: ${srcId}`);
      continue;
    }
    if (!tgt) {
      errors.push(`Edge connects to non-existent target node: ${tgtId}`);
      continue;
    }

    if (src.type === 'Result') {
      errors.push(`Result node '${srcId}' is an output sink and cannot have outgoing connections`);
      continue;
    }

    const srcPort = e.sourcePort || 'default';
    const tgtPort = e.targetPort || 'default';

    const validConnection = isPortConnectionValid(src.type, srcPort, tgt.type, tgtPort);
    if (!validConnection) {
      errors.push(`Incompatible connection: cannot connect '${src.type}' (${srcPort}) to '${tgt.type}' (${tgtPort})`);
      continue;
    }

    // Check duplicate target port usage
    if (tgtPort !== 'default') {
      const portKey = `${tgtId}:${tgtPort}`;
      if (targetPortUsage.has(portKey)) {
        errors.push(`Target port '${tgtPort}' on node '${tgtId}' is already connected; duplicate input connections are prohibited`);
      } else {
        targetPortUsage.set(portKey, 1);
      }
    }

    // Correlation node allows at most 2 numeric inputs (seriesA and seriesB)
    if (tgt.type === 'Correlation') {
      const count = (correlationInputCounts.get(tgtId) || 0) + 1;
      correlationInputCounts.set(tgtId, count);
      if (count > 2) {
        errors.push(`Correlation node '${tgtId}' exceeds maximum of 2 numeric input sources (seriesA and seriesB)`);
      }
    }

    // N-of-M node allows at most 1 input group
    if (tgt.type === 'N-of-M') {
      const count = (nofmInputCounts.get(tgtId) || 0) + 1;
      nofmInputCounts.set(tgtId, count);
      if (count > 1) {
        errors.push(`N-of-M node '${tgtId}' exceeds maximum of 1 input source`);
      }
    }
  }

  // Cycle check (DFS)
  const adj = new Map([...nodeMap.keys()].map(id => [id, []]));
  for (const e of edges) {
    const u = e.sourceNodeId || e.source;
    const v = e.targetNodeId || e.target;
    if (adj.has(u)) adj.get(u).push(v);
  }

  const visiting = new Set();
  const visited = new Set();

  const dfs = (id) => {
    if (visiting.has(id)) return true; // Cycle detected
    if (visited.has(id)) return false;

    visiting.add(id);
    for (const neighbor of adj.get(id) || []) {
      if (dfs(neighbor)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const id of nodeMap.keys()) {
    if (dfs(id)) {
      errors.push('Graph contains cyclical connections (cycles are not permitted in analysis flows)');
      break;
    }
  }

  const checksum = crypto
    .createHash('sha256')
    .update(JSON.stringify({ nodes, edges }))
    .digest('hex');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checksum
  };
}

