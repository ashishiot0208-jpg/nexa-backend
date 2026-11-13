/**
 * Topological execution runner for Correlation Workflows.
 * Evaluates nodes in dependency order, enforces time alignment, and stores results in BacktestRun.
 */

import mongoose from 'mongoose';
import {
  BacktestRun,
  CorrelationModel,
  DerivedReading,
  Instrument,
  SensorChannel,
  Device,
  DeviceTelemetry,
  ProjectGateway,
  DeviceGatewayMapping,
  Alarm,
  Notification
} from '../../models/index.js';
import { validateGraph } from './validation.js';
import { evaluateCorrelation } from './relationship.js';
import { evaluateNofM } from './nofm.js';

/**
 * Topologically sorts nodes using Kahn's algorithm.
 * @param {Array} nodes
 * @param {Array} edges
 * @returns {Array} Sorted nodes
 */
export function topologicalSort(nodes, edges) {
  const inDegree = new Map(nodes.map(n => [n.id, 0]));
  const adj = new Map(nodes.map(n => [n.id, []]));

  for (const e of edges) {
    const u = e.sourceNodeId || e.source;
    const v = e.targetNodeId || e.target;
    if (adj.has(u) && inDegree.has(v)) {
      adj.get(u).push(v);
      inDegree.set(v, inDegree.get(v) + 1);
    }
  }

  const queue = nodes.filter(n => inDegree.get(n.id) === 0);
  const sorted = [];

  while (queue.length > 0) {
    const node = queue.shift();
    sorted.push(node);

    for (const neighborId of adj.get(node.id) || []) {
      inDegree.set(neighborId, inDegree.get(neighborId) - 1);
      if (inDegree.get(neighborId) === 0) {
        const neighborNode = nodes.find(n => n.id === neighborId);
        if (neighborNode) queue.push(neighborNode);
      }
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error('Topological sort failed: graph contains cycles');
  }

  return sorted;
}

/**
 * Executes a BacktestRun asynchronously.
 * @param {string|mongoose.Types.ObjectId} runId
 */
export async function executeBacktest(runId) {
  const run = await BacktestRun.findById(runId);
  if (!run) return;

  try {
    run.status = 'RUNNING';
    run.startedAt = new Date();
    run.progress = 10;
    await run.save();

    const model = await CorrelationModel.findById(run.modelId).lean();
    if (!model) throw new Error('Correlation model not found');

    const version = model.versions?.find(v => v.version === run.modelVersion) || model.versions?.at(-1);
    if (!version || !version.graphJson) throw new Error(`Model version ${run.modelVersion} has no graphJson`);

    const graph = version.graphJson;
    const validation = validateGraph(graph);
    if (!validation.valid) {
      throw new Error(`Graph validation failed: ${validation.errors.join('; ')}`);
    }

    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const sortedNodes = topologicalSort(nodes, edges);

    const startAt = new Date(run.startAt);
    const endAt = new Date(run.endAt);

    run.progress = 25;
    await run.save();

    const nodeOutputs = new Map();
    const nodeDiagnostics = {};

    for (let i = 0; i < sortedNodes.length; i++) {
      const node = sortedNodes[i];
      const incomingEdges = edges.filter(e => (e.targetNodeId || e.target) === node.id);

      switch (node.type) {
        case 'Instrument': {
          const cfg = node.config || {};
          const field = cfg.field || 'value'; // 'value' | 'deltaFromBaseline' | 'ratePerHour'
          const instId = cfg.instrumentId;

          let instDoc = null;
          if (instId && mongoose.Types.ObjectId.isValid(instId)) {
            instDoc = await Instrument.findById(instId).lean();
          } else if (cfg.instrumentCode) {
            instDoc = await Instrument.findOne({
              projectId: run.projectId,
              code: cfg.instrumentCode
            }).lean();
          }

          // Canonical channel / parameterCode resolution:
          // node.config.parameterCode -> fallback node.config.channelCode -> fallback lookup through channelId if required
          let parameterCode = cfg.parameterCode || cfg.channelCode;
          if (!parameterCode && cfg.channelId && mongoose.Types.ObjectId.isValid(cfg.channelId)) {
            const channelDoc = await SensorChannel.findById(cfg.channelId).lean();
            parameterCode = channelDoc?.parameterCode || channelDoc?.code;
          }

          const instLabel = instDoc?.code || cfg.instrumentCode || node.title || node.id;
          if (!parameterCode) {
            throw new Error(`Instrument node "${instLabel}" has no selected channel/parameter.`);
          }

          let query = {
            projectId: run.projectId,
            observedAt: { $gte: startAt, $lte: endAt }
          };

          if (instDoc?._id || instId) query.instrumentId = instDoc ? instDoc._id : instId;
          query.parameterCode = parameterCode;

          const readings = await DerivedReading.find(query)
            .sort({ observedAt: 1 })
            .lean();

          const series = readings.map(r => ({
            observedAt: r.observedAt,
            value: (field in r && r[field] !== null && r[field] !== undefined) ? Number(r[field]) : Number(r.value),
            rawValue: r.value,
            quality: r.quality || 'VALID',
            unit: r.unit || ''
          }));

          const outputData = {
            type: 'SERIES',
            nodeId: node.id,
            instrumentId: instDoc?._id || instId,
            instrumentCode: instDoc?.code || cfg.instrumentCode || 'Instrument',
            instrumentName: instDoc?.name || 'Instrument',
            parameterCode,
            field,
            unit: series[0]?.unit || '',
            series
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'Instrument',
            instrument: instDoc?.code || cfg.instrumentCode,
            parameterCode,
            field,
            samplesLoaded: series.length
          };
          break;
        }

        case 'Instrument Group': {
          const cfg = node.config || {};
          const groupType = cfg.groupType || 'MANUAL';
          let parameterCode = cfg.parameterCode || cfg.channelCode || cfg.parameter;
          const field = cfg.field || 'value';

          const groupLabel = node.title || node.id;
          if (!parameterCode) {
            throw new Error(`Instrument Group node "${groupLabel}" has no selected parameter.`);
          }

          const instFilter = { projectId: run.projectId };

          if (groupType === 'MANUAL' && Array.isArray(cfg.instrumentIds) && cfg.instrumentIds.length) {
            instFilter._id = { $in: cfg.instrumentIds.filter(id => mongoose.Types.ObjectId.isValid(id)) };
          } else if (groupType === 'ZONE' && cfg.zoneId) {
            instFilter.zoneId = cfg.zoneId;
          } else if (groupType === 'SITE' && cfg.siteId) {
            instFilter.siteId = cfg.siteId;
          } else if (groupType === 'CATALOG' && cfg.catalogCode) {
            instFilter.catalogCode = cfg.catalogCode.toUpperCase();
          }

          const memberInstruments = await Instrument.find(instFilter).lean();
          const membersData = [];

          for (const inst of memberInstruments) {
            const query = {
              projectId: run.projectId,
              instrumentId: inst._id,
              observedAt: { $gte: startAt, $lte: endAt },
              parameterCode
            };

            const readings = await DerivedReading.find(query)
              .sort({ observedAt: 1 })
              .lean();

            membersData.push({
              instrumentId: inst._id.toString(),
              instrumentCode: inst.code,
              instrumentName: inst.name,
              unit: readings[0]?.unit || '',
              readings: readings.map(r => ({
                observedAt: r.observedAt,
                value: (field in r && r[field] !== null && r[field] !== undefined) ? Number(r[field]) : Number(r.value),
                quality: r.quality || 'VALID'
              }))
            });
          }

          const outputData = {
            type: 'GROUP',
            nodeId: node.id,
            groupType,
            parameterCode,
            field,
            members: membersData
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'Instrument Group',
            groupType,
            parameterCode,
            membersCount: membersData.length,
            totalSamples: membersData.reduce((acc, m) => acc + m.readings.length, 0)
          };
          break;
        }

        case 'Device': {
          const cfg = node.config || {};
          const metric = cfg.metric || 'batteryV'; // 'batteryV' | 'rssiDbm' | 'internalTempC'
          const devId = cfg.deviceId;

          let devDoc = null;
          if (devId && mongoose.Types.ObjectId.isValid(devId)) {
            devDoc = await Device.findById(devId).lean();
          } else if (devId) {
            devDoc = await Device.findOne({
              projectId: run.projectId,
              $or: [{ deviceId: devId }, { devEui: devId }]
            }).lean();
          }

          const targetDeviceId = devDoc ? devDoc._id : (mongoose.Types.ObjectId.isValid(devId) ? devId : null);

          let query = {
            projectId: run.projectId,
            observedAt: { $gte: startAt, $lte: endAt }
          };
          if (targetDeviceId) {
            query.deviceId = targetDeviceId;
          }

          const telemetries = await DeviceTelemetry.find(query)
            .sort({ observedAt: 1 })
            .lean();

          const unitMap = {
            batteryV: 'V',
            rssiDbm: 'dBm',
            internalTempC: '°C'
          };
          const unit = unitMap[metric] || '';

          const series = telemetries
            .filter(t => t[metric] !== null && t[metric] !== undefined && !Number.isNaN(Number(t[metric])))
            .map(t => ({
              observedAt: t.observedAt,
              value: Number(t[metric]),
              rawValue: t[metric],
              quality: 'VALID',
              unit
            }));

          const latestReading = telemetries.length ? telemetries[telemetries.length - 1] : null;

          const outputData = {
            type: 'SERIES',
            nodeType: 'Device',
            nodeId: node.id,
            deviceId: devDoc?.deviceId || cfg.deviceId || 'Device',
            deviceName: devDoc?.name || devDoc?.deviceId || 'Device',
            instrumentCode: devDoc?.deviceId || cfg.deviceCode || 'Device',
            parameterCode: metric,
            field: metric,
            unit,
            series,
            latestTelemetry: latestReading ? {
              observedAt: latestReading.observedAt,
              batteryV: latestReading.batteryV,
              rssiDbm: latestReading.rssiDbm,
              internalTempC: latestReading.internalTempC
            } : null
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'Device',
            deviceId: devDoc?.deviceId || cfg.deviceId,
            metric,
            samplesLoaded: series.length
          };
          break;
        }

        case 'Gateway': {
          const cfg = node.config || {};
          const gwId = cfg.gatewayId;

          let gwDoc = null;
          if (gwId && mongoose.Types.ObjectId.isValid(gwId)) {
            gwDoc = await ProjectGateway.findById(gwId).lean();
          } else if (gwId) {
            gwDoc = await ProjectGateway.findOne({
              projectId: run.projectId,
              $or: [{ gatewayId: gwId }, { gateway_uid: gwId }]
            }).lean();
          }

          let connectedCount = 0;
          if (gwDoc?._id) {
            connectedCount = await DeviceGatewayMapping.countDocuments({
              projectId: run.projectId,
              gatewayAssetId: gwDoc._id,
              status: 'ACTIVE'
            });
          }

          const outputData = {
            type: 'GATEWAY_CONTEXT',
            nodeType: 'Gateway',
            nodeId: node.id,
            gatewayId: gwDoc?.gatewayId || cfg.gatewayId || 'GW-UNKNOWN',
            name: gwDoc?.name || gwDoc?.gatewayId || 'Project Gateway',
            model: gwDoc?.model || 'Gateway Model',
            status: gwDoc?.status || 'ONLINE',
            activeBackhaul: gwDoc?.activeBackhaul || 'ethernet',
            connectedDeviceCount: connectedCount,
            updatedAt: gwDoc?.updatedAt || gwDoc?.createdAt || null
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'Gateway',
            gatewayId: outputData.gatewayId,
            status: outputData.status,
            activeBackhaul: outputData.activeBackhaul,
            connectedDeviceCount: connectedCount
          };
          break;
        }

        case 'Alarm': {
          const cfg = node.config || {};
          const scope = cfg.scope || 'PROJECT';
          const query = {
            projectId: run.projectId,
            $or: [
              { triggeredAt: { $gte: startAt, $lte: endAt } },
              { openedAt: { $gte: startAt, $lte: endAt } },
              { createdAt: { $gte: startAt, $lte: endAt } }
            ]
          };

          if (scope === 'INSTRUMENT' && cfg.instrumentId) {
            if (mongoose.Types.ObjectId.isValid(cfg.instrumentId)) {
              query.instrumentId = cfg.instrumentId;
            }
          }

          if (cfg.severity && cfg.severity !== 'ALL') {
            query.$and = query.$and || [];
            query.$and.push({
              $or: [
                { severity: cfg.severity },
                { currentSeverity: cfg.severity },
                { highestSeverity: cfg.severity }
              ]
            });
          }

          if (cfg.status && cfg.status !== 'ALL') {
            const st = String(cfg.status).toUpperCase();
            if (st === 'OPEN') {
              query.status = { $in: ['OPEN', 'TRIGGERED', 'UNDER_INVESTIGATION', 'ACTION_IN_PROGRESS', 'ESCALATED'] };
            } else if (st === 'ACKNOWLEDGED') {
              query.status = 'ACKNOWLEDGED';
            } else if (st === 'RESOLVED') {
              query.status = { $in: ['RESOLVED', 'CLOSED', 'CONDITION_NORMALIZED'] };
            } else {
              query.status = st;
            }
          }

          const alarms = await Alarm.find(query).sort({ triggeredAt: -1, createdAt: -1 }).limit(100).lean();

          const openStatuses = new Set(['OPEN', 'TRIGGERED', 'UNDER_INVESTIGATION', 'ACTION_IN_PROGRESS', 'ESCALATED']);
          const resolvedStatuses = new Set(['RESOLVED', 'CLOSED', 'CONDITION_NORMALIZED']);

          let openCount = 0;
          let ackCount = 0;
          let resCount = 0;
          const severityRanks = { S4: 5, S3: 4, S2: 3, S1: 2, S0: 1 };
          let maxSeverityVal = 0;
          let highestSeverity = 'None';

          for (const a of alarms) {
            const st = a.status || a.state || 'OPEN';
            if (openStatuses.has(st)) openCount++;
            else if (st === 'ACKNOWLEDGED') ackCount++;
            else if (resolvedStatuses.has(st)) resCount++;

            const sev = a.currentSeverity || a.highestSeverity || a.severity || 'S0';
            const r = severityRanks[sev] || 0;
            if (r > maxSeverityVal) {
              maxSeverityVal = r;
              highestSeverity = sev;
            }
          }

          const outputData = {
            type: 'ALARM_CONTEXT',
            nodeType: 'Alarm',
            nodeId: node.id,
            scope,
            instrumentId: cfg.instrumentId || null,
            alarmCount: alarms.length,
            openCount,
            acknowledgedCount: ackCount,
            resolvedCount: resCount,
            highestSeverity: maxSeverityVal > 0 ? highestSeverity : 'None',
            recentAlarms: alarms.slice(0, 10).map(a => ({
              id: a._id.toString(),
              title: a.title || 'Alarm Event',
              severity: a.currentSeverity || a.severity || 'S0',
              status: a.status || a.state || 'OPEN',
              triggeredAt: a.triggeredAt || a.openedAt || a.createdAt,
              acknowledgedAt: a.acknowledgedAt || null,
              resolvedAt: a.resolvedAt || null
            }))
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'Alarm',
            scope,
            alarmCount: alarms.length,
            openCount,
            highestSeverity: outputData.highestSeverity
          };
          break;
        }

        case 'Notification': {
          const cfg = node.config || {};
          const query = {
            projectId: run.projectId,
            $or: [
              { sentAt: { $gte: startAt, $lte: endAt } },
              { createdAt: { $gte: startAt, $lte: endAt } }
            ]
          };

          if (cfg.type && cfg.type !== 'ALL') {
            query.type = cfg.type;
          }
          if (cfg.importance && cfg.importance !== 'ALL') {
            query.importance = String(cfg.importance).toUpperCase();
          }
          if (cfg.channel && cfg.channel !== 'ALL') {
            query.channel = String(cfg.channel).toUpperCase();
          }

          const notifs = await Notification.find(query).sort({ createdAt: -1 }).limit(100).lean();

          const importanceBreakdown = { NORMAL: 0, IMPORTANT: 0, CRITICAL: 0 };
          const channelBreakdown = { IN_APP: 0, EMAIL: 0, SMS: 0 };

          for (const n of notifs) {
            const imp = String(n.importance || 'NORMAL').toUpperCase();
            if (imp in importanceBreakdown) importanceBreakdown[imp]++;
            else importanceBreakdown[imp] = (importanceBreakdown[imp] || 0) + 1;

            const ch = String(n.channel || 'IN_APP').toUpperCase();
            if (ch in channelBreakdown) channelBreakdown[ch]++;
            else channelBreakdown[ch] = (channelBreakdown[ch] || 0) + 1;
          }

          const outputData = {
            type: 'NOTIFICATION_CONTEXT',
            nodeType: 'Notification',
            nodeId: node.id,
            notificationCount: notifs.length,
            importanceBreakdown,
            channelBreakdown,
            recentNotifications: notifs.slice(0, 10).map(n => ({
              id: n._id.toString(),
              title: n.title || n.message || 'Notification',
              type: n.type || 'NOTIFICATION',
              importance: n.importance || 'NORMAL',
              channel: n.channel || 'IN_APP',
              status: n.status || 'SENT',
              sentAt: n.sentAt || n.createdAt,
              isRead: !!n.isRead
            }))
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'Notification',
            notificationCount: notifs.length,
            importanceBreakdown
          };
          break;
        }

        case 'Correlation': {
          const cfg = node.config || {};
          const edgeA = incomingEdges.find(e => (e.targetPort || 'seriesA') === 'seriesA');
          const edgeB = incomingEdges.find(e => (e.targetPort || 'seriesB') === 'seriesB');

          const inputA = edgeA ? nodeOutputs.get(edgeA.sourceNodeId || edgeA.source) : null;
          const inputB = edgeB ? nodeOutputs.get(edgeB.sourceNodeId || edgeB.source) : null;

          const seriesA = inputA?.series || [];
          const seriesB = inputB?.series || [];

          const corrResult = evaluateCorrelation({
            seriesA,
            seriesB,
            startAt,
            endAt,
            lagSearch: cfg.lagSearch === true,
            maxLagHours: Number(cfg.maxLagHours) || 24,
            lagStepHours: Number(cfg.lagStepHours) || 1,
            minSamples: Number(cfg.minSamples) || 20,
            qualityFilter: Array.isArray(cfg.qualityFilter) && cfg.qualityFilter.length ? cfg.qualityFilter : ['VALID'],
            labelA: inputA?.instrumentCode || 'Input A',
            labelB: inputB?.instrumentCode || 'Input B'
          });

          const outputData = {
            type: 'CORRELATION_RESULT',
            nodeId: node.id,
            inputA: { instrumentCode: inputA?.instrumentCode, parameterCode: inputA?.parameterCode, unit: inputA?.unit },
            inputB: { instrumentCode: inputB?.instrumentCode, parameterCode: inputB?.parameterCode, unit: inputB?.unit },
            result: corrResult
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'Correlation',
            lagSearch: cfg.lagSearch === true,
            r: corrResult.r,
            bestLagHours: corrResult.bestLagHours,
            samples: corrResult.samples
          };
          break;
        }

        case 'N-of-M': {
          const cfg = node.config || {};
          const inEdge = incomingEdges.find(e => (e.targetPort || 'groupIn') === 'groupIn');
          const inputGroup = inEdge ? nodeOutputs.get(inEdge.sourceNodeId || inEdge.source) : null;

          const members = inputGroup?.members || [];
          const nofmResult = evaluateNofM({
            members,
            requiredCount: Number(cfg.requiredCount) || 1,
            operator: cfg.operator || '>=',
            threshold: Number(cfg.threshold) || 0,
            qualityFilter: Array.isArray(cfg.qualityFilter) && cfg.qualityFilter.length ? cfg.qualityFilter : ['VALID']
          });

          const outputData = {
            type: 'NOFM_RESULT',
            nodeId: node.id,
            parameterCode: inputGroup?.parameterCode,
            field: inputGroup?.field,
            result: nofmResult
          };

          nodeOutputs.set(node.id, outputData);
          nodeDiagnostics[node.id] = {
            nodeType: 'N-of-M',
            requiredCount: nofmResult.requiredCount,
            totalMembers: nofmResult.totalMembers,
            confirmedCount: nofmResult.confirmedCount,
            passed: nofmResult.passed
          };
          break;
        }

        case 'Result': {
          const corrEdge = incomingEdges.find(e => (e.targetPort || 'correlationIn') === 'correlationIn');
          const nofmEdge = incomingEdges.find(e => (e.targetPort || 'nofmIn') === 'nofmIn');
          const gwEdge = incomingEdges.find(e => (e.targetPort || 'gatewayIn') === 'gatewayIn');
          const alarmEdge = incomingEdges.find(e => (e.targetPort || 'alarmIn') === 'alarmIn');
          const notifEdge = incomingEdges.find(e => (e.targetPort || 'notificationIn') === 'notificationIn');

          const corrInput = corrEdge ? nodeOutputs.get(corrEdge.sourceNodeId || corrEdge.source) : null;
          const nofmInput = nofmEdge ? nodeOutputs.get(nofmEdge.sourceNodeId || nofmEdge.source) : null;
          const gwInput = gwEdge ? nodeOutputs.get(gwEdge.sourceNodeId || gwEdge.source) : null;
          const alarmInput = alarmEdge ? nodeOutputs.get(alarmEdge.sourceNodeId || alarmEdge.source) : null;
          const notifInput = notifEdge ? nodeOutputs.get(notifEdge.sourceNodeId || notifEdge.source) : null;

          // Check if any Device node was input to Correlation
          let devInput = null;
          if (corrInput) {
            const corrNode = sortedNodes.find(n => n.id === corrInput.nodeId);
            if (corrNode) {
              const corrIncoming = edges.filter(e => (e.targetNodeId || e.target) === corrNode.id);
              for (const cie of corrIncoming) {
                const src = nodeOutputs.get(cie.sourceNodeId || cie.source);
                if (src && src.nodeType === 'Device') {
                  devInput = src;
                  break;
                }
              }
            }
          }

          const packagedResult = {
            type: 'EVIDENCE_PACKAGE',
            hasCorrelation: !!corrInput,
            hasNofM: !!nofmInput,
            hasGateway: !!gwInput,
            hasAlarm: !!alarmInput,
            hasNotification: !!notifInput,
            hasDevice: !!devInput,
            correlation: corrInput ? {
              inputA: corrInput.inputA,
              inputB: corrInput.inputB,
              r: corrInput.result.r,
              rZeroLag: corrInput.result.rZeroLag,
              bestLagHours: corrInput.result.bestLagHours,
              lagSemantics: corrInput.result.lagSemantics,
              relationship: corrInput.result.relationship,
              strength: corrInput.result.strength,
              direction: corrInput.result.direction,
              samples: corrInput.result.samples,
              minSamplesRequired: corrInput.result.minSamplesRequired,
              hasEnoughSamples: corrInput.result.hasEnoughSamples,
              sampleWarning: corrInput.result.sampleWarning,
              lagSearchPerformed: corrInput.result.lagSearchPerformed,
              diagnostics: corrInput.result.diagnostics
            } : null,
            nofm: nofmInput ? {
              parameterCode: nofmInput.parameterCode,
              field: nofmInput.field,
              requiredCount: nofmInput.result.requiredCount,
              totalMembers: nofmInput.result.totalMembers,
              confirmedCount: nofmInput.result.confirmedCount,
              passed: nofmInput.result.passed,
              status: nofmInput.result.status,
              ratio: nofmInput.result.ratio,
              operator: nofmInput.result.operator,
              threshold: nofmInput.result.threshold,
              summary: nofmInput.result.summary,
              memberEvaluations: nofmInput.result.memberEvaluations
            } : null,
            device: devInput ? {
              deviceId: devInput.deviceId,
              deviceName: devInput.deviceName,
              metric: devInput.parameterCode,
              unit: devInput.unit,
              latestTelemetry: devInput.latestTelemetry
            } : null,
            gateway: gwInput ? {
              gatewayId: gwInput.gatewayId,
              name: gwInput.name,
              model: gwInput.model,
              status: gwInput.status,
              activeBackhaul: gwInput.activeBackhaul,
              connectedDeviceCount: gwInput.connectedDeviceCount,
              updatedAt: gwInput.updatedAt
            } : null,
            alarm: alarmInput ? {
              scope: alarmInput.scope,
              alarmCount: alarmInput.alarmCount,
              openCount: alarmInput.openCount,
              acknowledgedCount: alarmInput.acknowledgedCount,
              resolvedCount: alarmInput.resolvedCount,
              highestSeverity: alarmInput.highestSeverity,
              recentAlarms: alarmInput.recentAlarms
            } : null,
            notification: notifInput ? {
              notificationCount: notifInput.notificationCount,
              importanceBreakdown: notifInput.importanceBreakdown,
              channelBreakdown: notifInput.channelBreakdown,
              recentNotifications: notifInput.recentNotifications
            } : null
          };

          // Build synchronized chart timeline points (downsample to at most 400 points for fast UI render)
          const timeline = [];
          if (corrInput?.result?.alignedTimestamps?.length) {
            const timestamps = corrInput.result.alignedTimestamps;
            const valsA = corrInput.result.alignedValuesA;
            const valsB = corrInput.result.alignedValuesB;
            const step = Math.max(1, Math.floor(timestamps.length / 400));

            for (let idx = 0; idx < timestamps.length; idx += step) {
              timeline.push({
                time: timestamps[idx],
                valueA: valsA[idx],
                valueB: valsB[idx],
                labelA: corrInput.inputA?.instrumentCode || 'Series A',
                labelB: corrInput.inputB?.instrumentCode || 'Series B',
                unitA: corrInput.inputA?.unit || '',
                unitB: corrInput.inputB?.unit || ''
              });
            }
          }

          nodeOutputs.set(node.id, { output: packagedResult, timeline });
          nodeDiagnostics[node.id] = {
            nodeType: 'Result',
            packagedEvidence: packagedResult
          };
          break;
        }

        default:
          break;
      }
    }

    // Collect final result from Result node or fallback to all outputs
    const resultNode = sortedNodes.find(n => n.type === 'Result');
    const finalPack = resultNode ? nodeOutputs.get(resultNode.id) : null;

    run.metrics = finalPack ? finalPack.output : Object.fromEntries(nodeOutputs);
    run.timeline = finalPack ? finalPack.timeline : [];
    run.nodeDiagnostics = {
      validatedGraph: validation,
      nodeDiagnostics
    };
    run.status = 'COMPLETED';
    run.progress = 100;
    run.finishedAt = new Date();
    await run.save();
  } catch (err) {
    run.status = 'FAILED';
    run.error = err.message;
    run.finishedAt = new Date();
    await run.save();
  }
}

