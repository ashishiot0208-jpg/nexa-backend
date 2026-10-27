import PDFDocument from 'pdfkit';

/**
 * Escapes values for RFC 4180 CSV output.
 */
function esc(v) {
  if (v === null || v === undefined) return '""';
  const str = String(v);
  return `"${str.replaceAll('"', '""')}"`;
}

function formatDate(val) {
  if (!val) return '—';
  try {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toISOString();
  } catch {
    return String(val);
  }
}

function formatNum(val, decimals = 3) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '—';
  return Number(val).toFixed(decimals);
}

function normalizeLabel(val) {
  if (val === null || val === undefined) return '—';
  const s = String(val).trim().toUpperCase();
  if (s === 'NOT_EVALUATED') return 'Not Evaluated';
  if (s === 'UNKNOWN') return 'Unknown';
  if (s === 'UNAVAILABLE') return 'Unavailable';
  if (s === 'COMMISSIONED') return 'Commissioned';
  if (s === 'UNCOMMISSIONED') return 'Uncommissioned';
  if (s === 'ONLINE') return 'Online';
  if (s === 'OFFLINE') return 'Offline';
  if (s === 'VALID') return 'Valid';
  if (s === 'SUSPECT') return 'Suspect';
  if (s === 'INVALID') return 'Invalid';
  if (s === 'OPEN') return 'Open';
  if (s === 'ACKNOWLEDGED') return 'Acknowledged';
  if (s === 'RESOLVED') return 'Resolved';
  if (s === 'IN_PROGRESS') return 'In Progress';
  if (s === 'COMPLETED') return 'Completed';
  return String(val);
}

// =========================================================================
// CSV EXPORT GENERATORS
// =========================================================================

export function generateReportCsv(reportType, report) {
  const data = report.data || {};
  const lines = [];

  switch (reportType) {
    case 'PROJECT_MONITORING_SUMMARY': {
      lines.push(['Category', 'Metric', 'Value', 'Details'].map(esc).join(','));
      // Instrument Coverage
      const cov = data.instrumentCoverage || {};
      lines.push(['Coverage', 'Total Instruments', cov.total ?? 0, ''].map(esc).join(','));
      lines.push(['Coverage', 'Commissioned', cov.commissioned ?? 0, ''].map(esc).join(','));
      lines.push(['Coverage', 'Positioned', cov.positioned ?? 0, ''].map(esc).join(','));
      lines.push(['Coverage', 'Unpositioned', cov.unpositioned ?? 0, ''].map(esc).join(','));
      lines.push(['Coverage', 'Reporting Telemetry', cov.reporting ?? 0, ''].map(esc).join(','));
      lines.push(['Coverage', 'No Telemetry', cov.noTelemetry ?? 0, ''].map(esc).join(','));

      // Severity Distribution
      const sev = data.severityDistribution || {};
      lines.push(['Severity', 'S0 (Normal)', sev.S0 ?? 0, ''].map(esc).join(','));
      lines.push(['Severity', 'S1 (Watch)', sev.S1 ?? 0, ''].map(esc).join(','));
      lines.push(['Severity', 'S2 (Advisory)', sev.S2 ?? 0, ''].map(esc).join(','));
      lines.push(['Severity', 'S3 (Warning)', sev.S3 ?? 0, ''].map(esc).join(','));
      lines.push(['Severity', 'S4 (Critical)', sev.S4 ?? 0, ''].map(esc).join(','));
      lines.push(['Severity', 'Not Evaluated', sev.NOT_EVALUATED ?? 0, ''].map(esc).join(','));

      // Quality Summary
      const q = data.measurementQuality || {};
      lines.push(['Quality', 'Valid Measurements', q.valid ?? 0, ''].map(esc).join(','));
      lines.push(['Quality', 'Suspect Measurements', q.suspect ?? 0, ''].map(esc).join(','));
      lines.push(['Quality', 'Invalid Measurements', q.invalid ?? 0, ''].map(esc).join(','));
      lines.push(['Quality', 'Unavailable Measurements', q.unavailable ?? 0, ''].map(esc).join(','));

      // Infrastructure
      const inf = data.infrastructure || {};
      lines.push(['Infrastructure', 'Devices Online', inf.devices?.online ?? 0, `Total: ${inf.devices?.total ?? 0}, Offline: ${inf.devices?.offline ?? 0}`].map(esc).join(','));
      lines.push(['Infrastructure', 'Gateways Online', inf.gateways?.online ?? 0, `Total: ${inf.gateways?.total ?? 0}, Offline: ${inf.gateways?.offline ?? 0}`].map(esc).join(','));

      // Alarms
      const alm = data.alarmSummary || {};
      lines.push(['Alarms', 'Total Alarms', alm.total ?? 0, ''].map(esc).join(','));
      lines.push(['Alarms', 'Open Alarms', alm.open ?? 0, ''].map(esc).join(','));
      lines.push(['Alarms', 'Acknowledged Alarms', alm.acknowledged ?? 0, ''].map(esc).join(','));
      lines.push(['Alarms', 'Resolved Alarms', alm.resolved ?? 0, ''].map(esc).join(','));

      // Investigations
      const inv = data.investigationSummary || {};
      lines.push(['Investigations', 'Total Investigations', inv.total ?? 0, ''].map(esc).join(','));
      lines.push(['Investigations', 'Open Investigations', inv.open ?? 0, ''].map(esc).join(','));
      lines.push(['Investigations', 'In Progress Investigations', inv.inProgress ?? 0, ''].map(esc).join(','));
      lines.push(['Investigations', 'Completed Investigations', inv.completed ?? 0, ''].map(esc).join(','));
      break;
    }

    case 'INSTRUMENT_TREND': {
      lines.push([
        'Timestamp',
        'Instrument Code',
        'Instrument Name',
        'Parameter',
        'Engineering Value',
        'Unit',
        'Raw Value',
        'Raw Unit',
        'Delta From Baseline',
        'Quality',
        'Severity'
      ].map(esc).join(','));

      const instCode = data.instrument?.code || '';
      const instName = data.instrument?.name || '';
      const param = data.parameter?.code || '';
      const unit = data.parameter?.unit || '';

      const readings = data.readings || [];
      for (const r of readings) {
        lines.push([
          formatDate(r.timestamp),
          instCode,
          instName,
          param,
          r.engineeringValue !== null && r.engineeringValue !== undefined ? Number(r.engineeringValue).toFixed(3) : '—',
          unit,
          r.rawValue !== null && r.rawValue !== undefined ? r.rawValue : '—',
          r.rawUnit || '',
          formatNum(r.deltaFromBaseline),
          normalizeLabel(r.quality || 'NOT_EVALUATED'),
          r.severity || 'S0'
        ].map(esc).join(','));
      }
      break;
    }

    case 'ALARM_HISTORY': {
      lines.push([
        'Alarm',
        'Title',
        'Category',
        'Asset',
        'Parameter',
        'Initial Severity',
        'Current Severity',
        'Highest Severity',
        'Status',
        'Triggered At',
        'Acknowledged At',
        'Resolved At',
        'Resolution Reason'
      ].map(esc).join(','));

      const alarms = data.alarms || [];
      for (const a of alarms) {
        lines.push([
          a.code || a.id || '',
          a.title || '',
          a.category || '',
          a.instrument?.code || a.instrument?.name || a.assetCode || '—',
          a.parameterCode || a.parameter || '—',
          a.initialSeverity || '—',
          a.currentSeverity || '—',
          a.highestSeverity || '—',
          a.status || '',
          formatDate(a.triggeredAt),
          formatDate(a.acknowledgedAt),
          formatDate(a.resolvedAt),
          a.resolutionReason || a.resolutionSummary || '—'
        ].map(esc).join(','));
      }
      break;
    }

    case 'INVESTIGATION_SUMMARY': {
      lines.push([
        'Investigation',
        'Title',
        'Source Alarm',
        'Asset',
        'Assigned To',
        'Priority',
        'Status',
        'Created',
        'Started',
        'Completed',
        'Conclusion'
      ].map(esc).join(','));

      const invs = data.investigations || [];
      for (const i of invs) {
        lines.push([
          i.code || i.id || '',
          i.title || '',
          i.sourceAlarm?.code || i.alarmCode || '—',
          i.asset?.instrument?.code || i.assetCode || '—',
          i.assignedTo?.name || i.assignedTo?.email || '—',
          i.priority || '—',
          i.status || '',
          formatDate(i.createdAt),
          formatDate(i.startedAt),
          formatDate(i.completedAt),
          i.finalOutcome?.conclusion || i.conclusion || '—'
        ].map(esc).join(','));
      }
      break;
    }

    case 'INFRASTRUCTURE_HEALTH': {
      lines.push([
        'Asset Type',
        'Code',
        'Name',
        'Model',
        'Commissioning Status',
        'Runtime Connectivity',
        'Mapped Count',
        'Parent Mapping',
        'Last Seen'
      ].map(esc).join(','));

      const devices = data.devices?.items || [];
      for (const d of devices) {
        lines.push([
          'Device',
          d.code || d.id || '',
          d.name || '',
          d.model || '—',
          normalizeLabel(d.commissioningStatus || 'UNCOMMISSIONED'),
          normalizeLabel(d.runtimeConnectivity || 'UNKNOWN'),
          d.mappedSensorsCount ?? 0,
          d.gateway?.code || d.gateway?.name || '—',
          formatDate(d.lastTelemetryAt || d.lastSeen)
        ].map(esc).join(','));
      }

      const gateways = data.gateways?.items || [];
      for (const g of gateways) {
        lines.push([
          'Gateway',
          g.code || g.id || '',
          g.name || '',
          g.model || '—',
          normalizeLabel(g.commissioningStatus || 'UNCOMMISSIONED'),
          normalizeLabel(g.runtimeConnectivity || 'UNKNOWN'),
          g.mappedDevicesCount ?? 0,
          '—',
          formatDate(g.lastSeen)
        ].map(esc).join(','));
      }
      break;
    }

    case 'SEVERITY_MONITORING_SUMMARY': {
      lines.push([
        'Instrument',
        'Parameter',
        'Latest Value',
        'Unit',
        'Delta From Baseline',
        'Severity',
        'Quality',
        'Effective Rule',
        'Rule Version',
        'Observed At'
      ].map(esc).join(','));

      const insts = data.instruments || [];
      for (const it of insts) {
        lines.push([
          it.instrument?.code || it.instrument?.name || '',
          it.parameter || '—',
          it.latestEngineeringValue !== null && it.latestEngineeringValue !== undefined ? Number(it.latestEngineeringValue).toFixed(3) : '—',
          it.unit || '',
          it.deltaFromBaseline !== null && it.deltaFromBaseline !== undefined ? Number(it.deltaFromBaseline).toFixed(3) : '—',
          it.currentSeverity === 'NOT_EVALUATED' ? 'Not Evaluated' : (it.currentSeverity || '—'),
          normalizeLabel(it.quality || 'NOT_EVALUATED'),
          it.effectiveRule?.name || 'No Rule',
          it.effectiveRule?.version || '—',
          formatDate(it.timestamp)
        ].map(esc).join(','));
      }
      break;
    }

    default:
      lines.push(['Message'].map(esc).join(','));
      lines.push(['No tabular export available for this report type.'].map(esc).join(','));
      break;
  }

  return lines.join('\n');
}

// =========================================================================
// PDF EXPORT GENERATORS
// =========================================================================

/**
 * Standard PDF styling palette
 */
const PALETTE = {
  primary: '#0F5132',      // Dark NexaIQ Green
  primaryLight: '#E8F5E9', // Pale Green Tint
  accent: '#198754',       // Action Green
  dark: '#212529',         // Charcoal Slate Body
  muted: '#6C757D',        // Muted Slate
  border: '#DEE2E6',       // Border Slate
  bgHeader: '#F8F9FA',     // Light Table Header
  bgZebra: '#FAFAFA',      // Very subtle zebra
  // Restrained Severity
  sevS0: '#198754',
  sevS1: '#0D6EFD',
  sevS2: '#D97706',
  sevS3: '#EA580C',
  sevS4: '#DC2626',
  sevNone: '#6B7280'
};

function getSeverityColor(sev) {
  switch (String(sev).toUpperCase()) {
    case 'S0': return PALETTE.sevS0;
    case 'S1': return PALETTE.sevS1;
    case 'S2': return PALETTE.sevS2;
    case 'S3': return PALETTE.sevS3;
    case 'S4': return PALETTE.sevS4;
    default: return PALETTE.sevNone;
  }
}

/**
 * Renders consistent NexaIQ header on the first page.
 */
function drawDocumentHeader(doc, reportTitle, report) {
  const proj = report.project || {};
  const period = report.period || {};
  const meta = report.metadata || {};

  doc.save();

  // Logo / Brand
  doc.font('Helvetica-Bold').fontSize(16).fillColor(PALETTE.primary).text('NexaIQ', { continued: false });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(PALETTE.dark).text(reportTitle.toUpperCase());
  doc.moveDown(0.4);

  // Metadata block (2 columns)
  const leftX = doc.page.margins.left;
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2;
  const startY = doc.y;

  // Left column
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETTE.muted).text('PROJECT: ', leftX, startY, { continued: true });
  doc.font('Helvetica').fillColor(PALETTE.dark).text(`${proj.name || '—'} [${proj.code || '—'}]`);

  doc.font('Helvetica-Bold').fillColor(PALETTE.muted).text('SITE / LOC: ', leftX, doc.y, { continued: true });
  doc.font('Helvetica').fillColor(PALETTE.dark).text(`${proj.location || 'Primary Site'} · Timezone: ${proj.timezone || 'UTC'}`);

  const leftBottomY = doc.y;

  // Right column
  const rightX = leftX + colWidth;
  const isCurrentState = report.reportType === 'SEVERITY_MONITORING_SUMMARY' || report.reportType === 'INFRASTRUCTURE_HEALTH';
  if (isCurrentState) {
    doc.font('Helvetica-Bold').fillColor(PALETTE.muted).text('REPORT BASIS: ', rightX, startY, { continued: true });
    doc.font('Helvetica').fillColor(PALETTE.dark).text('Current State');
  } else {
    doc.font('Helvetica-Bold').fillColor(PALETTE.muted).text('REPORT PERIOD: ', rightX, startY, { continued: true });
    const periodStr = period.from && period.to
      ? `${formatDate(period.from).split('T')[0]} to ${formatDate(period.to).split('T')[0]}`
      : (period.from ? `From ${formatDate(period.from).split('T')[0]}` : 'All Telemetry');
    doc.font('Helvetica').fillColor(PALETTE.dark).text(periodStr);
  }

  doc.font('Helvetica-Bold').fillColor(PALETTE.muted).text('GENERATED: ', rightX, doc.y, { continued: true });
  doc.font('Helvetica').fillColor(PALETTE.dark).text(`${formatDate(report.generatedAt || new Date())}`);

  const nextY = Math.max(leftBottomY, doc.y) + 6;
  doc.strokeColor(PALETTE.border).lineWidth(1).moveTo(leftX, nextY).lineTo(doc.page.width - doc.page.margins.right, nextY).stroke();
  doc.y = nextY + 12;

  doc.restore();
}

/**
 * Draws section title.
 */
function drawSectionHeader(doc, title) {
  if (doc.y > doc.page.height - 100) doc.addPage();
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETTE.primary).text(title.toUpperCase());
  doc.moveDown(0.3);
}

/**
 * Draws KPI metric cards in a row.
 */
function drawKpiRow(doc, items = []) {
  if (doc.y > doc.page.height - 80) doc.addPage();
  const startX = doc.page.margins.left;
  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cardWidth = (totalWidth - (items.length - 1) * 8) / items.length;
  const cardHeight = 36;
  const startY = doc.y;

  items.forEach((item, idx) => {
    const x = startX + idx * (cardWidth + 8);
    // Card background
    doc.save()
      .rect(x, startY, cardWidth, cardHeight)
      .fillColor(item.bg || '#F8F9FA')
      .fill()
      .rect(x, startY, cardWidth, cardHeight)
      .strokeColor(item.border || PALETTE.border)
      .lineWidth(0.75)
      .stroke();

    // Value
    doc.font('Helvetica-Bold').fontSize(12).fillColor(item.color || PALETTE.dark)
      .text(String(item.value ?? '—'), x + 6, startY + 5, { width: cardWidth - 12, align: 'center' });
    // Label
    doc.font('Helvetica').fontSize(7.5).fillColor(PALETTE.muted)
      .text(item.label.toUpperCase(), x + 4, startY + 21, { width: cardWidth - 8, align: 'center' });
    doc.restore();
  });

  doc.y = startY + cardHeight + 8;
}

/**
 * Draws a clean tabular grid.
 */
function drawTable(doc, headers = [], rows = [], colWidths = []) {
  const startX = doc.page.margins.left;
  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rowHeight = 18;

  // Auto compute widths if not provided
  const widths = colWidths.length === headers.length
    ? colWidths
    : headers.map(() => totalWidth / headers.length);

  function printHeader() {
    doc.save()
      .rect(startX, doc.y, totalWidth, rowHeight)
      .fillColor(PALETTE.bgHeader)
      .fill()
      .rect(startX, doc.y, totalWidth, rowHeight)
      .strokeColor(PALETTE.border)
      .lineWidth(0.5)
      .stroke();

    let curX = startX;
    headers.forEach((h, i) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.dark)
        .text(String(h).toUpperCase(), curX + 4, doc.y + 5, { width: widths[i] - 8, align: 'left', lineBreak: false });
      curX += widths[i];
    });
    doc.restore();
    doc.y += rowHeight;
  }

  printHeader();

  rows.forEach((row, rIdx) => {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      printHeader();
    }

    const y = doc.y;
    if (rIdx % 2 === 1) {
      doc.save().rect(startX, y, totalWidth, rowHeight).fillColor(PALETTE.bgZebra).fill().restore();
    }
    doc.save()
      .strokeColor(PALETTE.border)
      .lineWidth(0.3)
      .moveTo(startX, y + rowHeight)
      .lineTo(startX + totalWidth, y + rowHeight)
      .stroke()
      .restore();

    let curX = startX;
    row.forEach((cell, cIdx) => {
      const isSev = headers[cIdx] === 'SEV' || headers[cIdx] === 'SEVERITY' || headers[cIdx] === 'INITIAL' || headers[cIdx] === 'HIGHEST';
      const cellVal = cell === null || cell === undefined ? '—' : String(cell);
      doc.save();
      if (isSev && cellVal !== '—') {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(getSeverityColor(cellVal));
      } else {
        doc.font('Helvetica').fontSize(7.5).fillColor(PALETTE.dark);
      }
      doc.text(cellVal, curX + 4, y + 4.5, { width: widths[cIdx] - 8, align: 'left', lineBreak: false });
      doc.restore();
      curX += widths[cIdx];
    });

    doc.y = y + rowHeight;
  });

  doc.y += 6;
}

/**
 * Main export PDF entry point.
 */
export function generateReportPdf(reportType, report) {
  return new Promise((resolve, reject) => {
    // Select orientation based on report type
    const isLandscape = [
      'INSTRUMENT_TREND',
      'ALARM_HISTORY',
      'INFRASTRUCTURE_HEALTH',
      'INVESTIGATION_SUMMARY'
    ].includes(reportType);

    const doc = new PDFDocument({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
      bufferPages: true
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      // Add page numbering across all pages
      const pageRange = doc.bufferedPageRange();
      for (let i = 0; i < pageRange.count; i++) {
        doc.switchToPage(i);
        doc.save();
        const footerY = doc.page.height - 24;
        doc.font('Helvetica').fontSize(7).fillColor(PALETTE.muted);
        doc.text(
          `NexaIQ Operational Report · Generated: ${formatDate(report.generatedAt || new Date())}`,
          doc.page.margins.left,
          footerY,
          { width: (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2, align: 'left' }
        );
        doc.text(
          `Page ${i + 1} of ${pageRange.count}`,
          doc.page.margins.left + (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2,
          footerY,
          { width: (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2, align: 'right' }
        );
        doc.restore();
      }
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    const data = report.data || {};

    switch (reportType) {
      // -------------------------------------------------------------------
      // 1. PROJECT MONITORING SUMMARY
      // -------------------------------------------------------------------
      case 'PROJECT_MONITORING_SUMMARY': {
        drawDocumentHeader(doc, 'Project Monitoring Summary', report);

        // Section A: Instrument Coverage
        drawSectionHeader(doc, 'A. Instrument Coverage');
        const cov = data.instrumentCoverage || {};
        drawKpiRow(doc, [
          { label: 'Total', value: cov.total ?? 0 },
          { label: 'Commissioned', value: cov.commissioned ?? 0 },
          { label: 'Positioned', value: cov.positioned ?? 0 },
          { label: 'Unpositioned', value: cov.unpositioned ?? 0 },
          { label: 'Reporting', value: cov.reporting ?? 0 },
          { label: 'No Telemetry', value: cov.noTelemetry ?? 0 }
        ]);

        // Section B: Current Severity Distribution
        drawSectionHeader(doc, 'B. Geotechnical Severity Distribution');
        const sev = data.severityDistribution || {};
        drawKpiRow(doc, [
          { label: 'S0 Normal', value: sev.S0 ?? 0, color: PALETTE.sevS0 },
          { label: 'S1 Watch', value: sev.S1 ?? 0, color: PALETTE.sevS1 },
          { label: 'S2 Advisory', value: sev.S2 ?? 0, color: PALETTE.sevS2 },
          { label: 'S3 Warning', value: sev.S3 ?? 0, color: PALETTE.sevS3 },
          { label: 'S4 Critical', value: sev.S4 ?? 0, color: PALETTE.sevS4 },
          { label: 'Not Evaluated', value: sev.NOT_EVALUATED ?? 0, color: PALETTE.sevNone }
        ]);

        // Section C: Measurement Quality
        drawSectionHeader(doc, 'C. Measurement Quality');
        const q = data.measurementQuality || {};
        drawKpiRow(doc, [
          { label: 'Valid', value: q.valid ?? 0 },
          { label: 'Suspect', value: q.suspect ?? 0 },
          { label: 'Invalid', value: q.invalid ?? 0 },
          { label: 'Unavailable', value: q.unavailable ?? 0 }
        ]);

        // Section D: Infrastructure
        drawSectionHeader(doc, 'D. Infrastructure Connectivity');
        const inf = data.infrastructure || {};
        drawKpiRow(doc, [
          { label: 'Devices Total', value: inf.devices?.total ?? 0 },
          { label: 'Devices Online', value: inf.devices?.online ?? 0, color: PALETTE.sevS0 },
          { label: 'Devices Offline', value: inf.devices?.offline ?? 0, color: inf.devices?.offline > 0 ? PALETTE.sevS3 : PALETTE.muted },
          { label: 'Gateways Total', value: inf.gateways?.total ?? 0 },
          { label: 'Gateways Online', value: inf.gateways?.online ?? 0, color: PALETTE.sevS0 },
          { label: 'Gateways Offline', value: inf.gateways?.offline ?? 0, color: inf.gateways?.offline > 0 ? PALETTE.sevS3 : PALETTE.muted }
        ]);

        // Section E: Alarm Summary
        drawSectionHeader(doc, 'E. Alarm Summary');
        const alm = data.alarmSummary || {};
        drawKpiRow(doc, [
          { label: 'Total Alarms', value: alm.total ?? 0 },
          { label: 'Open', value: alm.open ?? 0, color: alm.open > 0 ? PALETTE.sevS4 : PALETTE.muted },
          { label: 'Acknowledged', value: alm.acknowledged ?? 0, color: alm.acknowledged > 0 ? PALETTE.sevS2 : PALETTE.muted },
          { label: 'Resolved', value: alm.resolved ?? 0, color: PALETTE.sevS0 }
        ]);

        // Section F: Investigation Summary
        drawSectionHeader(doc, 'F. Investigation Summary');
        const inv = data.investigationSummary || {};
        drawKpiRow(doc, [
          { label: 'Total', value: inv.total ?? 0 },
          { label: 'Open', value: inv.open ?? 0 },
          { label: 'In Progress', value: inv.inProgress ?? 0 },
          { label: 'Completed', value: inv.completed ?? 0, color: PALETTE.sevS0 }
        ]);
        break;
      }

      // -------------------------------------------------------------------
      // 2. INSTRUMENT TREND REPORT
      // -------------------------------------------------------------------
      case 'INSTRUMENT_TREND': {
        drawDocumentHeader(doc, 'Instrument Trend Report', report);

        const inst = data.instrument || {};
        const param = data.parameter || {};
        const summary = data.summary || {};

        // Instrument Meta Block
        doc.save();
        const startX = doc.page.margins.left;
        const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        doc.rect(startX, doc.y, totalW, 40).fillColor('#F8F9FA').fill().rect(startX, doc.y, totalW, 40).strokeColor(PALETTE.border).stroke();
        
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETTE.dark)
          .text(`Instrument: ${inst.name || '—'} [${inst.code || '—'}] · Type: ${inst.catalogCode || inst.model || '—'} · Site: ${inst.site || '—'} · Zone: ${inst.zone || '—'}`, startX + 6, doc.y + 6);
        doc.font('Helvetica').fontSize(8).fillColor(PALETTE.muted)
          .text(`Parameter: ${param.name || param.code || '—'} · Unit: ${param.unit || '—'} · Baseline: ${param.baselineValue !== null ? `${param.baselineValue} ${param.unit}` : 'Not Configured'} · Aggregation: ${data.aggregation || 'RAW'}`, startX + 6, doc.y + 14);
        doc.restore();
        doc.y += 46;

        // Numeric Summary KPI Row
        drawSectionHeader(doc, 'Summary Statistics');
        drawKpiRow(doc, [
          { label: 'First Value', value: summary.firstValue !== null ? `${formatNum(summary.firstValue)} ${param.unit || ''}` : '—' },
          { label: 'Last Value', value: summary.lastValue !== null ? `${formatNum(summary.lastValue)} ${param.unit || ''}` : '—' },
          { label: 'Minimum', value: summary.minimum !== null ? `${formatNum(summary.minimum)} ${param.unit || ''}` : '—' },
          { label: 'Maximum', value: summary.maximum !== null ? `${formatNum(summary.maximum)} ${param.unit || ''}` : '—' },
          { label: 'Average', value: summary.average !== null ? `${formatNum(summary.average)} ${param.unit || ''}` : '—' },
          { label: 'Change', value: summary.change !== null ? `${formatNum(summary.change)} ${param.unit || ''}` : '—' },
          { label: 'Sample Count', value: summary.sampleCount ?? 0 }
        ]);

        // Data Table
        drawSectionHeader(doc, 'Engineering Measurement Records');
        const readings = data.readings || [];
        const headers = ['TIMESTAMP', 'ENG VALUE', 'RAW VALUE', 'DELTA', 'QUALITY', 'SEVERITY'];
        const colWidths = [180, 110, 110, 110, 130, 129];
        const rows = readings.slice(0, 1500).map(r => [
          formatDate(r.timestamp),
          r.engineeringValue !== null ? `${formatNum(r.engineeringValue)} ${param.unit || ''}` : '—',
          r.rawValue !== null ? String(r.rawValue) : '—',
          r.deltaFromBaseline !== null ? `${formatNum(r.deltaFromBaseline)} ${param.unit || ''}` : '—',
          r.quality || 'NOT_EVALUATED',
          r.severity || 'S0'
        ]);

        if (rows.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(9).fillColor(PALETTE.muted).text('No measurement records found for the selected period.', startX, doc.y);
        } else {
          drawTable(doc, headers, rows, colWidths);
        }
        break;
      }

      // -------------------------------------------------------------------
      // 3. ALARM HISTORY REPORT
      // -------------------------------------------------------------------
      case 'ALARM_HISTORY': {
        drawDocumentHeader(doc, 'Alarm History Report', report);

        const summary = data.summary || {};
        drawSectionHeader(doc, 'Alarm Lifecycle Summary');
        drawKpiRow(doc, [
          { label: 'Total Alarms', value: summary.total ?? 0 },
          { label: 'Open', value: summary.open ?? 0, color: summary.open > 0 ? PALETTE.sevS4 : PALETTE.muted },
          { label: 'Acknowledged', value: summary.acknowledged ?? 0, color: summary.acknowledged > 0 ? PALETTE.sevS2 : PALETTE.muted },
          { label: 'Resolved', value: summary.resolved ?? 0, color: PALETTE.sevS0 }
        ]);

        drawSectionHeader(doc, 'Alarm Records');
        const alarms = data.alarms || [];
        const headers = ['ALARM CODE', 'CATEGORY', 'ASSET', 'PARAMETER', 'INITIAL', 'HIGHEST', 'STATUS', 'TRIGGERED', 'RESOLVED'];
        const colWidths = [90, 80, 85, 75, 50, 50, 75, 132, 132];
        const rows = alarms.map(a => [
          a.code || a.id || '—',
          a.category || '—',
          a.instrument?.code || a.assetCode || '—',
          a.parameterCode || a.parameter || '—',
          a.initialSeverity || '—',
          a.highestSeverity || '—',
          a.status || '—',
          formatDate(a.triggeredAt),
          formatDate(a.resolvedAt)
        ]);

        if (rows.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(9).fillColor(PALETTE.muted).text('No alarms found matching active filters.', doc.page.margins.left, doc.y);
        } else {
          drawTable(doc, headers, rows, colWidths);
        }
        break;
      }

      // -------------------------------------------------------------------
      // 4. INVESTIGATION SUMMARY REPORT
      // -------------------------------------------------------------------
      case 'INVESTIGATION_SUMMARY': {
        drawDocumentHeader(doc, 'Investigation Summary Report', report);

        const summary = data.summary || {};
        drawSectionHeader(doc, 'Investigations Overview');
        drawKpiRow(doc, [
          { label: 'Total Investigations', value: summary.total ?? 0 },
          { label: 'Open', value: summary.open ?? 0 },
          { label: 'In Progress', value: summary.inProgress ?? 0 },
          { label: 'Completed', value: summary.completed ?? 0, color: PALETTE.sevS0 }
        ]);

        drawSectionHeader(doc, 'Investigation Records');
        const invs = data.investigations || [];
        const headers = ['INVESTIGATION', 'TITLE', 'SOURCE ALARM', 'ASSET', 'ASSIGNED TO', 'PRIORITY', 'STATUS', 'STARTED', 'COMPLETED'];
        const colWidths = [85, 130, 85, 80, 80, 55, 65, 95, 94];
        const rows = invs.map(i => [
          i.code || i.id || '—',
          i.title || '—',
          i.sourceAlarm?.code || '—',
          i.asset?.instrument?.code || '—',
          i.assignedTo?.name || '—',
          i.priority || '—',
          i.status || '—',
          formatDate(i.startedAt),
          formatDate(i.completedAt)
        ]);

        if (rows.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(9).fillColor(PALETTE.muted).text('No investigations found matching active filters.', doc.page.margins.left, doc.y);
        } else {
          drawTable(doc, headers, rows, colWidths);
        }
        break;
      }

      // -------------------------------------------------------------------
      // 5. SINGLE INVESTIGATION DETAIL REPORT (A4 Portrait)
      // -------------------------------------------------------------------
      case 'INVESTIGATION_DETAIL': {
        drawDocumentHeader(doc, 'Investigation Engineering Record', report);

        const inv = data.investigation || {};
        const snap = data.sourceAlarm || {};
        const asset = data.asset || {};
        const assignment = data.assignment || {};
        const outcome = data.finalOutcome || {};
        const findings = data.findings || [];
        const audit = data.audit || [];

        // 1. Investigation Details Card
        drawSectionHeader(doc, '1. Investigation Details');
        drawKpiRow(doc, [
          { label: 'Code', value: inv.code || '—' },
          { label: 'Status', value: inv.status || '—', color: inv.status === 'COMPLETED' ? PALETTE.sevS0 : PALETTE.sevS1 },
          { label: 'Priority', value: inv.priority || '—' },
          { label: 'Created', value: formatDate(inv.createdAt).split('T')[0] },
          { label: 'Completed', value: inv.completedAt ? formatDate(inv.completedAt).split('T')[0] : 'In Progress' }
        ]);

        // 2. Source Alarm & Asset Info
        drawSectionHeader(doc, '2. Source Alarm & Asset Context');
        const startX = doc.page.margins.left;
        const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        doc.save().rect(startX, doc.y, totalW, 46).fillColor('#F8F9FA').fill().rect(startX, doc.y, totalW, 46).strokeColor(PALETTE.border).stroke();
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETTE.dark)
          .text(`Alarm: ${snap.title || snap.id || '—'} · Category: ${snap.category || '—'} · Parameter: ${snap.parameter || '—'}`, startX + 6, doc.y + 6);
        doc.font('Helvetica').fontSize(8).fillColor(PALETTE.muted)
          .text(`Initial Severity: ${snap.initialSeverity || '—'} · Highest Severity: ${snap.highestSeverity || '—'} · Triggered: ${formatDate(snap.triggeredAt)}`, startX + 6, doc.y + 14);
        doc.font('Helvetica').fontSize(8).fillColor(PALETTE.dark)
          .text(`Asset: ${asset.instrument?.name || asset.device?.name || '—'} [${asset.instrument?.code || asset.device?.code || '—'}] · Assigned To: ${assignment.assignedTo?.name || 'Unassigned'}`, startX + 6, doc.y + 22);
        doc.restore();
        doc.y += 52;

        // 3. Investigation Brief
        drawSectionHeader(doc, '3. Investigation Brief');
        doc.font('Helvetica').fontSize(8.5).fillColor(PALETTE.dark).text(data.description || 'No initial brief provided.', startX, doc.y, { width: totalW });
        doc.moveDown(0.6);

        // 4. Chronological Findings
        drawSectionHeader(doc, '4. Engineering Findings');
        if (findings.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(PALETTE.muted).text('No findings recorded.', startX, doc.y);
        } else {
          findings.forEach((f, idx) => {
            doc.save();
            const fY = doc.y;
            if (fY > doc.page.height - 60) doc.addPage();
            doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.primary)
              .text(`[${idx + 1}] ${formatDate(f.createdAt)} · ${f.createdBy?.name || 'Engineer'}:`, startX, doc.y);
            doc.font('Helvetica').fontSize(8).fillColor(PALETTE.dark)
              .text(f.body || '', startX + 10, doc.y, { width: totalW - 10 });
            doc.restore();
            doc.moveDown(0.4);
          });
        }

        // 5. Final Outcome
        drawSectionHeader(doc, '5. Final Outcome & Recommended Action');
        doc.save().rect(startX, doc.y, totalW, 54).fillColor('#F8F9FA').fill().rect(startX, doc.y, totalW, 54).strokeColor(PALETTE.border).stroke();
        doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.dark).text('Conclusion: ', startX + 6, doc.y + 5, { continued: true });
        doc.font('Helvetica').fillColor(PALETTE.muted).text(outcome.conclusion || 'Pending conclusion');
        doc.font('Helvetica-Bold').fillColor(PALETTE.dark).text('Root Cause: ', startX + 6, doc.y + 3, { continued: true });
        doc.font('Helvetica').fillColor(PALETTE.muted).text(outcome.rootCause || 'Under investigation');
        doc.font('Helvetica-Bold').fillColor(PALETTE.dark).text('Recommended Action: ', startX + 6, doc.y + 3, { continued: true });
        doc.font('Helvetica').fillColor(PALETTE.muted).text(outcome.recommendedAction || 'None specified');
        doc.restore();
        doc.y += 60;

        // 6. Audit Trail
        drawSectionHeader(doc, '6. Immutable Audit Trail');
        const auditHeaders = ['TIMESTAMP', 'EVENT TYPE', 'ACTOR'];
        const auditWidths = [180, 160, totalW - 340];
        const auditRows = audit.map(a => [formatDate(a.timestamp), a.eventType || '—', a.actor?.name || 'System']);
        drawTable(doc, auditHeaders, auditRows, auditWidths);
        break;
      }

      // -------------------------------------------------------------------
      // 6. INFRASTRUCTURE HEALTH REPORT
      // -------------------------------------------------------------------
      case 'INFRASTRUCTURE_HEALTH': {
        drawDocumentHeader(doc, 'Infrastructure Health Report', report);

        const devSummary = data.devices?.summary || {};
        const gwSummary = data.gateways?.summary || {};

        drawSectionHeader(doc, 'Infrastructure Connectivity Summary');
        drawKpiRow(doc, [
          { label: 'Devices Total', value: devSummary.total ?? 0 },
          { label: 'Devices Commissioned', value: devSummary.commissioned ?? 0 },
          { label: 'Devices Online', value: devSummary.online ?? 0, color: PALETTE.sevS0 },
          { label: 'Devices Offline', value: devSummary.offline ?? 0, color: devSummary.offline > 0 ? PALETTE.sevS3 : PALETTE.muted },
          { label: 'Gateways Total', value: gwSummary.total ?? 0 },
          { label: 'Gateways Commissioned', value: gwSummary.commissioned ?? 0 },
          { label: 'Gateways Online', value: gwSummary.online ?? 0, color: PALETTE.sevS0 },
          { label: 'Gateways Offline', value: gwSummary.offline ?? 0, color: gwSummary.offline > 0 ? PALETTE.sevS3 : PALETTE.muted }
        ]);

        drawSectionHeader(doc, 'Edge Devices');
        const devItems = data.devices?.items || [];
        const devHeaders = ['DEVICE CODE', 'NAME', 'MODEL', 'COMMISSIONING', 'CONNECTIVITY', 'SENSORS', 'GATEWAY', 'LAST TELEMETRY'];
        const devColWidths = [100, 100, 85, 95, 85, 55, 90, 159];
        const devRows = devItems.map(d => [
          d.code || d.id || '—',
          d.name || '—',
          d.model || '—',
          normalizeLabel(d.commissioningStatus || 'UNCOMMISSIONED'),
          normalizeLabel(d.runtimeConnectivity || 'UNKNOWN'),
          String(d.mappedSensorsCount ?? 0),
          d.gateway?.code || d.gateway?.name || '—',
          formatDate(d.lastTelemetryAt || d.lastSeen)
        ]);
        if (devRows.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(PALETTE.muted).text('No edge devices found in this project.', doc.page.margins.left, doc.y);
        } else {
          drawTable(doc, devHeaders, devRows, devColWidths);
        }

        drawSectionHeader(doc, 'Field Gateways');
        const gwItems = data.gateways?.items || [];
        const gwHeaders = ['GATEWAY CODE', 'NAME', 'MODEL', 'COMMISSIONING', 'CONNECTIVITY', 'DEVICES', 'LAST SEEN'];
        const gwColWidths = [110, 120, 100, 105, 95, 60, 179];
        const gwRows = gwItems.map(g => [
          g.code || g.id || '—',
          g.name || '—',
          g.model || '—',
          g.commissioningStatus || 'UNCOMMISSIONED',
          g.runtimeConnectivity || 'UNKNOWN',
          String(g.mappedDevicesCount ?? 0),
          formatDate(g.lastSeen)
        ]);
        if (gwRows.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(PALETTE.muted).text('No gateways found in this project.', doc.page.margins.left, doc.y);
        } else {
          drawTable(doc, gwHeaders, gwRows, gwColWidths);
        }
        break;
      }

      // -------------------------------------------------------------------
      // 7. SEVERITY / MONITORING SUMMARY
      // -------------------------------------------------------------------
      case 'SEVERITY_MONITORING_SUMMARY': {
        drawDocumentHeader(doc, 'Severity / Monitoring Summary', report);

        const summary = data.summary || {};
        const dist = summary.severityDistribution || {};

        drawSectionHeader(doc, 'Severity Status Distribution');
        drawKpiRow(doc, [
          { label: 'Total Instruments', value: summary.totalInstruments ?? 0 },
          { label: 'Reporting', value: summary.reportingInstruments ?? 0 },
          { label: 'S0 Normal', value: dist.S0 ?? 0, color: PALETTE.sevS0 },
          { label: 'S1 Watch', value: dist.S1 ?? 0, color: PALETTE.sevS1 },
          { label: 'S2 Advisory', value: dist.S2 ?? 0, color: PALETTE.sevS2 },
          { label: 'S3 Warning', value: dist.S3 ?? 0, color: PALETTE.sevS3 },
          { label: 'S4 Critical', value: dist.S4 ?? 0, color: PALETTE.sevS4 },
          { label: 'Not Evaluated', value: dist.NOT_EVALUATED ?? 0, color: PALETTE.sevNone }
        ]);

        drawSectionHeader(doc, 'Instrument Engineering Severity Overview');
        const insts = data.instruments || [];
        const headers = ['INSTRUMENT', 'PARAM', 'VALUE', 'UNIT', 'DELTA', 'SEV', 'QUALITY', 'RULE', 'OBSERVED AT'];
        const colWidths = [90, 70, 60, 45, 55, 45, 75, 80, 102];
        const rows = insts.map(it => [
          it.instrument?.code || '—',
          it.parameter || '—',
          it.latestEngineeringValue !== null ? formatNum(it.latestEngineeringValue) : '—',
          it.unit || '',
          it.deltaFromBaseline !== null ? formatNum(it.deltaFromBaseline) : '—',
          it.currentSeverity === 'NOT_EVALUATED' ? 'Not Evaluated' : (it.currentSeverity || '—'),
          normalizeLabel(it.quality || 'NOT_EVALUATED'),
          it.effectiveRule?.name || 'No Rule',
          formatDate(it.timestamp)
        ]);

        if (rows.length === 0) {
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(PALETTE.muted).text('No instruments configured.', doc.page.margins.left, doc.y);
        } else {
          drawTable(doc, headers, rows, colWidths);
        }
        break;
      }

      default:
        drawDocumentHeader(doc, 'Operational Report', report);
        doc.font('Helvetica').fontSize(10).fillColor(PALETTE.dark).text('Report preview generated successfully.');
        break;
    }

    doc.end();
  });
}
