import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { Report } from '../models/index.js';
import { getProjectOverview } from './overview.service.js';

const reportsDir = path.resolve('uploads/reports');
fs.mkdirSync(reportsDir, { recursive: true });

export async function generateProjectSummary(reportId) {
  const report = await Report.findById(reportId);
  if (!report) return;
  try {
    report.status = 'GENERATING'; await report.save();
    const overview = await getProjectOverview(report.projectId);
    const filename = `report-${report._id}.pdf`;
    const storagePath = path.join(reportsDir, filename);
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(storagePath);
    doc.pipe(stream);
    doc.fontSize(20).text('GeoNexa Project Summary');
    doc.moveDown().fontSize(12).text(`${overview.project.name} (${overview.project.code})`);
    doc.text(`Location: ${overview.project.location || '-'}`);
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown().fontSize(14).text('Current Status');
    doc.fontSize(11).text(`Geotechnical severity: ${overview.status.severity}`);
    doc.text(`Monitoring health: ${overview.status.monitoringHealth}`);
    doc.text(`Confidence: ${overview.status.confidence}% (${overview.status.confidenceBand})`);
    doc.text(`Primary reason: ${overview.status.primaryReason}`);
    doc.moveDown().fontSize(14).text('Assets');
    doc.fontSize(11).text(`Instruments: ${overview.counts.instruments}`);
    doc.text(`Devices: ${overview.counts.devices} (${overview.counts.onlineDevices} online)`);
    doc.text(`Open alarms: ${overview.counts.openAlarms}`);
    doc.moveDown().fontSize(14).text('Latest Measurements');
    for (const row of overview.latest.slice(0, 20)) doc.fontSize(10).text(`${row.parameterCode}: ${row.value?.toFixed?.(3) ?? row.value} ${row.unit || ''} · ${row.quality}`);
    doc.end();
    await new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); });
    report.filename = filename; report.storagePath = storagePath; report.status = 'READY'; await report.save();
  } catch (err) { report.status = 'FAILED'; report.error = err.message; await report.save(); }
}
