import crypto from 'node:crypto';
import { BacktestRun, CorrelationModel, DerivedReading } from '../models/index.js';

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const x = xs.slice(0, n), y = ys.slice(0, n);
  const mx = x.reduce((a,b)=>a+b,0)/n, my = y.reduce((a,b)=>a+b,0)/n;
  let num=0, dx=0, dy=0;
  for(let i=0;i<n;i++){const a=x[i]-mx,b=y[i]-my;num+=a*b;dx+=a*a;dy+=b*b;}
  return dx && dy ? num / Math.sqrt(dx*dy) : null;
}

export function validateGraph(graph) {
  const nodes = graph?.nodes || [], edges = graph?.edges || [];
  const ids = new Set(nodes.map((n) => n.id));
  const errors = [];
  if (!nodes.length) errors.push('Graph has no nodes');
  for (const e of edges) if (!ids.has(e.source) || !ids.has(e.target)) errors.push(`Invalid edge ${e.source} -> ${e.target}`);
  const adj = new Map([...ids].map((id) => [id, []]));
  for (const e of edges) if (adj.has(e.source)) adj.get(e.source).push(e.target);
  const visiting = new Set(), visited = new Set();
  const dfs = (id) => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const n of adj.get(id) || []) if (dfs(n)) return true; visiting.delete(id); visited.add(id); return false; };
  for (const id of ids) if (dfs(id)) { errors.push('Cycles are not allowed'); break; }
  return { valid: errors.length === 0, errors, checksum: crypto.createHash('sha256').update(JSON.stringify(graph || {})).digest('hex') };
}

export async function executeBacktest(runId) {
  const run = await BacktestRun.findById(runId);
  if (!run) return;
  try {
    run.status = 'RUNNING'; run.startedAt = new Date(); run.progress = 10; await run.save();
    const model = await CorrelationModel.findById(run.modelId).lean();
    const version = model?.versions?.find((v) => v.version === run.modelVersion);
    const inputNodes = (version?.graphJson?.nodes || []).filter((n) => n.type === 'INPUT' && n.parameterCode);
    const series = [];
    for (const node of inputNodes.slice(0, 2)) {
      const rows = await DerivedReading.find({ projectId: run.projectId, parameterCode: node.parameterCode, observedAt: { $gte: run.startAt, $lte: run.endAt }, quality: { $in: ['VALID', 'SUSPECT', 'MANUALLY_VERIFIED'] } }).sort({ observedAt: 1 }).lean();
      series.push({ node, rows });
    }
    run.progress = 70; await run.save();
    let coefficient = null;
    if (series.length >= 2) coefficient = pearson(series[0].rows.map((r) => r.value), series[1].rows.map((r) => r.value));
    run.metrics = { sampleCounts: series.map((s) => ({ parameterCode: s.node.parameterCode, count: s.rows.length })), pearson: coefficient };
    run.nodeDiagnostics = { validatedGraph: validateGraph(version?.graphJson || {}), note: 'Phase-1 backtest executes aligned first-two-input Pearson evidence. Extend node runtimes as approved.' };
    run.status = 'COMPLETED'; run.progress = 100; run.finishedAt = new Date(); await run.save();
  } catch (err) {
    run.status = 'FAILED'; run.error = err.message; run.finishedAt = new Date(); await run.save();
  }
}
