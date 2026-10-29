import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Report } from '../models/index.js';
import { requireAuth, requireProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  generateProjectSummary,
  getProjectMonitoringReport,
  getInstrumentTrendReport,
  getAlarmHistoryReport,
  getInvestigationReport,
  getInvestigationSummaryReport,
  getInfrastructureHealthReport,
  getSeveritySummaryReport,
  getOverallProjectReport
} from '../services/report.service.js';
import { ApiError } from '../utils/api-error.js';
import {
  generateReportCsv,
  generateReportPdf
} from '../services/report-export.service.js';

const router = Router();
router.use(requireAuth);

// =========================================================================
// CANONICAL PROJECT REPORT ENDPOINTS (PHASE C8A)
// =========================================================================

/**
 * 1. Project Monitoring Summary Report
 */
router.get(
  '/projects/:projectId/reports/monitoring-summary',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getProjectMonitoringReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      user: req.auth
    });
    res.json(report);
  })
);

/**
 * 2. Instrument Trend Report
 */
router.get(
  '/projects/:projectId/reports/instrument-trend',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInstrumentTrendReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      instrumentId: req.query.instrumentId,
      parameterCode: req.query.parameterCode || req.query.parameter,
      channel: req.query.channel,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      aggregation: req.query.aggregation || req.query.bucket,
      user: req.auth
    });
    res.json(report);
  })
);

/**
 * 3. Alarm History Report (Canonical lifecycleVersion: 2 only)
 */
router.get(
  '/projects/:projectId/reports/alarms',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const detailed = String(req.query.detailed || '').toLowerCase() === 'true' || req.query.detailed === '1';
    const report = await getAlarmHistoryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      status: req.query.status,
      category: req.query.category,
      instrumentId: req.query.instrumentId,
      severity: req.query.severity,
      detailed,
      page: req.query.page,
      limit: req.query.limit,
      user: req.auth
    });
    res.json(report);
  })
);

/**
 * 4. Investigation Reports
 * - List / Summary: /projects/:projectId/reports/investigations
 * - Detailed Single: /projects/:projectId/reports/investigations/:investigationId
 */
router.get(
  '/projects/:projectId/reports/investigations',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInvestigationSummaryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      status: req.query.status,
      priority: req.query.priority,
      instrumentId: req.query.instrumentId,
      page: req.query.page,
      limit: req.query.limit,
      user: req.auth
    });
    res.json(report);
  })
);

router.get(
  '/projects/:projectId/reports/investigations/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInvestigationSummaryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      status: req.query.status,
      priority: req.query.priority,
      instrumentId: req.query.instrumentId,
      page: 1,
      limit: 2000,
      isExport: true,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'INVESTIGATION_SUMMARY',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Investigation_Summary_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/investigations/csv',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInvestigationSummaryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      status: req.query.status,
      priority: req.query.priority,
      instrumentId: req.query.instrumentId,
      page: 1,
      limit: 2000,
      isExport: true,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'INVESTIGATION_SUMMARY',
      format: 'csv',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Investigation_Summary_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/investigations/:investigationId/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInvestigationReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      investigationId: req.params.investigationId,
      user: req.auth
    });
    const invCode = report.data?.investigation?.code || req.params.investigationId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'INVESTIGATION_DETAIL',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${invCode}_Investigation_Report_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/investigations/:investigationId',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInvestigationReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      investigationId: req.params.investigationId,
      user: req.auth
    });
    res.json(report);
  })
);

/**
 * 5. Infrastructure Health Report
 */
router.get(
  '/projects/:projectId/reports/infrastructure',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInfrastructureHealthReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      user: req.auth
    });
    res.json(report);
  })
);

/**
 * 6. Severity / Monitoring Summary Report
 */
router.get(
  '/projects/:projectId/reports/severity',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getSeveritySummaryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      user: req.auth
    });
    res.json(report);
  })
);

/**
 * 7. Overall Project Monitoring Report (Phase C8C)
 */
router.get(
  '/projects/:projectId/reports/overall',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const includeTrendCharts = req.query.includeTrendCharts !== 'false' && req.query.includeTrendCharts !== '0';
    const includeAlarmDetails = req.query.includeAlarmDetails !== 'false' && req.query.includeAlarmDetails !== '0';
    const includeInvestigationDetails = req.query.includeInvestigationDetails !== 'false' && req.query.includeInvestigationDetails !== '0';

    const report = await getOverallProjectReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      options: {
        includeTrendCharts,
        includeAlarmDetails,
        includeInvestigationDetails
      },
      user: req.auth
    });
    res.json(report);
  })
);

router.get(
  '/projects/:projectId/reports/overall/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const includeTrendCharts = req.query.includeTrendCharts !== 'false' && req.query.includeTrendCharts !== '0';
    const includeAlarmDetails = req.query.includeAlarmDetails !== 'false' && req.query.includeAlarmDetails !== '0';
    const includeInvestigationDetails = req.query.includeInvestigationDetails !== 'false' && req.query.includeInvestigationDetails !== '0';

    const report = await getOverallProjectReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      options: {
        includeTrendCharts,
        includeAlarmDetails,
        includeInvestigationDetails
      },
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'OVERALL_PROJECT_MONITORING',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Overall_Project_Report_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/overall/csv',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const includeTrendCharts = req.query.includeTrendCharts !== 'false' && req.query.includeTrendCharts !== '0';
    const includeAlarmDetails = req.query.includeAlarmDetails !== 'false' && req.query.includeAlarmDetails !== '0';
    const includeInvestigationDetails = req.query.includeInvestigationDetails !== 'false' && req.query.includeInvestigationDetails !== '0';

    const report = await getOverallProjectReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      options: {
        includeTrendCharts,
        includeAlarmDetails,
        includeInvestigationDetails
      },
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'OVERALL_PROJECT_MONITORING',
      format: 'csv',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Overall_Project_Report_${dateStr}`
    });
  })
);

function sanitizeFilename(str) {
  return String(str || '').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

async function sendExportResponse(res, { reportType, format, reportData, baseFilename }) {
  const ext = String(format || 'pdf').toLowerCase() === 'pdf' ? 'pdf' : 'csv';
  const filename = `${sanitizeFilename(baseFilename)}.${ext}`;

  if (ext === 'pdf') {
    const buffer = await generateReportPdf(reportType, reportData);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('content-length', buffer.length);
    return res.end(buffer);
  } else {
    const csv = generateReportCsv(reportType, reportData);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  }
}

// =========================================================================
// CANONICAL PDF / CSV EXPORT ENDPOINTS (PHASE C8B)
// =========================================================================

/**
 * 1. Project Monitoring Summary Export (PDF & CSV)
 */
router.get(
  '/projects/:projectId/reports/monitoring-summary/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getProjectMonitoringReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'PROJECT_MONITORING_SUMMARY',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Monitoring_Summary_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/monitoring-summary/csv',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getProjectMonitoringReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'PROJECT_MONITORING_SUMMARY',
      format: 'csv',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Monitoring_Summary_${dateStr}`
    });
  })
);

/**
 * 2. Instrument Trend Export (PDF & CSV)
 */
router.get(
  '/projects/:projectId/reports/instrument-trend/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInstrumentTrendReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      instrumentId: req.query.instrumentId,
      parameterCode: req.query.parameterCode || req.query.parameter,
      channel: req.query.channel,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      aggregation: req.query.aggregation || req.query.bucket,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const instCode = report.data?.instrument?.code || 'INST';
    const param = report.data?.parameter?.code || 'PARAM';
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'INSTRUMENT_TREND',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Trend_${instCode}_${param}_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/instrument-trend/csv',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInstrumentTrendReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      instrumentId: req.query.instrumentId,
      parameterCode: req.query.parameterCode || req.query.parameter,
      channel: req.query.channel,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      aggregation: req.query.aggregation || req.query.bucket,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const instCode = report.data?.instrument?.code || 'INST';
    const param = report.data?.parameter?.code || 'PARAM';
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'INSTRUMENT_TREND',
      format: 'csv',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Trend_${instCode}_${param}_${dateStr}`
    });
  })
);

/**
 * 3. Alarm History Export (PDF & CSV)
 */
router.get(
  '/projects/:projectId/reports/alarms/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const detailed = String(req.query.detailed || '').toLowerCase() === 'true' || req.query.detailed === '1';
    const report = await getAlarmHistoryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      status: req.query.status,
      category: req.query.category,
      instrumentId: req.query.instrumentId,
      severity: req.query.severity,
      detailed,
      page: 1,
      limit: 2000,
      isExport: true,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'ALARM_HISTORY',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Alarm_History_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/alarms/csv',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const detailed = String(req.query.detailed || '').toLowerCase() === 'true' || req.query.detailed === '1';
    const report = await getAlarmHistoryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      status: req.query.status,
      category: req.query.category,
      instrumentId: req.query.instrumentId,
      severity: req.query.severity,
      detailed,
      page: 1,
      limit: 2000,
      isExport: true,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'ALARM_HISTORY',
      format: 'csv',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Alarm_History_${dateStr}`
    });
  })
);

/**
 * 5. Infrastructure Health Export (PDF & CSV)
 */
router.get(
  '/projects/:projectId/reports/infrastructure/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInfrastructureHealthReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'INFRASTRUCTURE_HEALTH',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Infrastructure_Health_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/infrastructure/csv',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getInfrastructureHealthReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'INFRASTRUCTURE_HEALTH',
      format: 'csv',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Infrastructure_Health_${dateStr}`
    });
  })
);

/**
 * 6. Severity / Monitoring Summary Export (PDF & CSV)
 */
router.get(
  '/projects/:projectId/reports/severity/pdf',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getSeveritySummaryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'SEVERITY_MONITORING_SUMMARY',
      format: 'pdf',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Severity_Summary_${dateStr}`
    });
  })
);

router.get(
  '/projects/:projectId/reports/severity/csv',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const report = await getSeveritySummaryReport({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId,
      user: req.auth
    });
    const projectCode = report.project?.code || req.params.projectId;
    const dateStr = new Date().toISOString().split('T')[0];
    await sendExportResponse(res, {
      reportType: 'SEVERITY_MONITORING_SUMMARY',
      format: 'csv',
      reportData: report,
      baseFilename: `NexaIQ_${projectCode}_Severity_Summary_${dateStr}`
    });
  })
);

/**
 * Unified Export Route: /projects/:projectId/reports/export?type=...&format=pdf|csv
 */
router.get(
  '/projects/:projectId/reports/export',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const type = String(req.query.type || req.query.reportType || '').trim().toLowerCase();
    const format = String(req.query.format || 'pdf').trim().toLowerCase();

    if (type === 'monitoring-summary' || type === 'monitoring_summary' || type === 'monitoring') {
      const report = await getProjectMonitoringReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        from: req.query.from,
        to: req.query.to,
        period: req.query.period,
        user: req.auth
      });
      const projectCode = report.project?.code || req.params.projectId;
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'PROJECT_MONITORING_SUMMARY',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${projectCode}_Monitoring_Summary_${dateStr}`
      });
    }

    if (type === 'instrument-trend' || type === 'trend' || type === 'instrument_trend') {
      const report = await getInstrumentTrendReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        instrumentId: req.query.instrumentId,
        parameterCode: req.query.parameterCode || req.query.parameter,
        channel: req.query.channel,
        from: req.query.from,
        to: req.query.to,
        period: req.query.period,
        aggregation: req.query.aggregation || req.query.bucket,
        user: req.auth
      });
      const projectCode = report.project?.code || req.params.projectId;
      const instCode = report.data?.instrument?.code || 'INST';
      const param = report.data?.parameter?.code || 'PARAM';
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'INSTRUMENT_TREND',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${projectCode}_Trend_${instCode}_${param}_${dateStr}`
      });
    }

    if (type === 'alarms' || type === 'alarm' || type === 'alarm-history' || type === 'alarm_history') {
      const detailed = String(req.query.detailed || '').toLowerCase() === 'true' || req.query.detailed === '1';
      const report = await getAlarmHistoryReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        from: req.query.from,
        to: req.query.to,
        period: req.query.period,
        status: req.query.status,
        category: req.query.category,
        instrumentId: req.query.instrumentId,
        severity: req.query.severity,
        detailed,
        page: 1,
        limit: 2000,
        isExport: true,
        user: req.auth
      });
      const projectCode = report.project?.code || req.params.projectId;
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'ALARM_HISTORY',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${projectCode}_Alarm_History_${dateStr}`
      });
    }

    if (type === 'investigations' || type === 'investigation-summary' || type === 'investigation_summary') {
      if (req.query.investigationId) {
        const report = await getInvestigationReport({
          projectId: req.params.projectId,
          organizationId: req.auth.organizationId,
          investigationId: req.query.investigationId,
          user: req.auth
        });
        const invCode = report.data?.investigation?.code || req.query.investigationId;
        const dateStr = new Date().toISOString().split('T')[0];
        return sendExportResponse(res, {
          reportType: 'INVESTIGATION_DETAIL',
          format,
          reportData: report,
          baseFilename: `NexaIQ_${invCode}_Investigation_Report_${dateStr}`
        });
      }

      const report = await getInvestigationSummaryReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        from: req.query.from,
        to: req.query.to,
        period: req.query.period,
        status: req.query.status,
        priority: req.query.priority,
        instrumentId: req.query.instrumentId,
        page: 1,
        limit: 2000,
        isExport: true,
        user: req.auth
      });
      const projectCode = report.project?.code || req.params.projectId;
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'INVESTIGATION_SUMMARY',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${projectCode}_Investigation_Summary_${dateStr}`
      });
    }

    if (type === 'investigation-detail' || type === 'investigation_detail') {
      if (!req.query.investigationId) throw new ApiError(400, 'investigationId is required');
      const report = await getInvestigationReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        investigationId: req.query.investigationId,
        user: req.auth
      });
      const invCode = report.data?.investigation?.code || req.query.investigationId;
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'INVESTIGATION_DETAIL',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${invCode}_Investigation_Report_${dateStr}`
      });
    }

    if (type === 'infrastructure' || type === 'infrastructure-health' || type === 'infrastructure_health') {
      const report = await getInfrastructureHealthReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        user: req.auth
      });
      const projectCode = report.project?.code || req.params.projectId;
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'INFRASTRUCTURE_HEALTH',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${projectCode}_Infrastructure_Health_${dateStr}`
      });
    }

    if (type === 'severity' || type === 'severity-summary' || type === 'severity_summary') {
      const report = await getSeveritySummaryReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        user: req.auth
      });
      const projectCode = report.project?.code || req.params.projectId;
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'SEVERITY_MONITORING_SUMMARY',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${projectCode}_Severity_Summary_${dateStr}`
      });
    }

    if (type === 'overall' || type === 'overall-project' || type === 'overall_project' || type === 'overall_project_monitoring') {
      const includeTrendCharts = req.query.includeTrendCharts !== 'false' && req.query.includeTrendCharts !== '0';
      const includeAlarmDetails = req.query.includeAlarmDetails !== 'false' && req.query.includeAlarmDetails !== '0';
      const includeInvestigationDetails = req.query.includeInvestigationDetails !== 'false' && req.query.includeInvestigationDetails !== '0';

      const report = await getOverallProjectReport({
        projectId: req.params.projectId,
        organizationId: req.auth.organizationId,
        from: req.query.from,
        to: req.query.to,
        period: req.query.period,
        options: {
          includeTrendCharts,
          includeAlarmDetails,
          includeInvestigationDetails
        },
        user: req.auth
      });
      const projectCode = report.project?.code || req.params.projectId;
      const dateStr = new Date().toISOString().split('T')[0];
      return sendExportResponse(res, {
        reportType: 'OVERALL_PROJECT_MONITORING',
        format,
        reportData: report,
        baseFilename: `NexaIQ_${projectCode}_Overall_Project_Report_${dateStr}`
      });
    }

    throw new ApiError(400, `Unsupported report export type: ${type}`);
  })
);


// =========================================================================
// BACKWARD COMPATIBILITY: PRE-EXISTING REPORT ASYNCHRONOUS EXPORTS
// =========================================================================

router.get(
  '/projects/:projectId/reports',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const reports = await Report.find({
      projectId: req.params.projectId,
      organizationId: req.auth.organizationId
    }).sort({ createdAt: -1 }).lean();
    res.json(reports);
  })
);

router.post(
  '/projects/:projectId/reports',
  requireProjectAccess,
  asyncHandler(async (req, res) => {
    const r = await Report.create({
      organizationId: req.auth.organizationId,
      projectId: req.params.projectId,
      name: req.body.name || 'Project Summary',
      reportType: req.body.reportType || 'PROJECT_SUMMARY',
      periodStart: req.body.periodStart,
      periodEnd: req.body.periodEnd,
      status: 'QUEUED',
      generatedBy: req.auth.userId
    });
    setImmediate(() => generateProjectSummary(r._id));
    res.status(202).json(r);
  })
);

router.get(
  '/reports/:id',
  asyncHandler(async (req, res) => {
    const r = await Report.findOne({ _id: req.params.id, organizationId: req.auth.organizationId }).lean();
    if (!r) throw new ApiError(404, 'Report not found');
    res.json(r);
  })
);

router.get(
  '/reports/:id/download',
  asyncHandler(async (req, res) => {
    const r = await Report.findOne({ _id: req.params.id, organizationId: req.auth.organizationId });
    if (!r || r.status !== 'READY' || !r.storagePath || !fs.existsSync(r.storagePath)) {
      throw new ApiError(404, 'Report file not ready');
    }
    res.download(path.resolve(r.storagePath), r.filename);
  })
);

export default router;
