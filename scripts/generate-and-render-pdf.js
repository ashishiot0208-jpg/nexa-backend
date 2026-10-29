import mongoose from 'mongoose';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { env } from '../src/config/env.js';
import { getOverallProjectReport } from '../src/services/report.service.js';
import { generateReportPdf } from '../src/services/report-export.service.js';
import { Project } from '../src/models/index.js';

async function main() {
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  console.log('Connected to Primary DB');

  const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
  if (!project) throw new Error('LAN-PRO-01 not found');

  const report = await getOverallProjectReport({
    projectId: project._id,
    period: '30d',
    options: {
      includeTrendCharts: true,
      includeAlarmDetails: true,
      includeInvestigationDetails: true
    },
    user: {
      displayName: 'Site Engineer',
      email: 'org1@yopmail.com'
    }
  });

  const pdfBuffer = await generateReportPdf('OVERALL_PROJECT_MONITORING', report);
  const outDir = '/Users/mac/.gemini/antigravity-ide/brain/4700f8ec-e0e9-451b-8fd7-4a6dab5d0fa5';
  const pdfPath = `${outDir}/c8c-overall-report.pdf`;
  fs.writeFileSync(pdfPath, pdfBuffer);
  console.log(`Saved PDF to ${pdfPath} (${pdfBuffer.length} bytes)`);

  // Remove existing c8c-page-*.png before rendering
  for (let p = 1; p <= 10; p++) {
    const f = `${outDir}/c8c-page-${p}.png`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // Render every page to PNG using macOS JXA / PDFKit
  const jxaCmd = `osascript -l JavaScript -e "
ObjC.import('PDFKit');
ObjC.import('AppKit');
var pdfUrl = $.NSURL.fileURLWithPath('${pdfPath}');
var pdfDoc = $.PDFDocument.alloc.initWithURL(pdfUrl);
for (var i = 0; i < pdfDoc.pageCount; i++) {
  var page = pdfDoc.pageAtIndex(i);
  var bounds = page.boundsForBox($.kPDFDisplayBoxMediaBox);
  var img = $.NSImage.alloc.initWithSize(bounds.size);
  img.lockFocus;
  var ctx = $.NSGraphicsContext.currentContext.CGContext;
  $.CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
  $.CGContextFillRect(ctx, bounds);
  page.drawWithBoxToContext($.kPDFDisplayBoxMediaBox, ctx);
  img.unlockFocus;
  var tiff = img.TIFFRepresentation;
  var rep = $.NSBitmapImageRep.imageRepsWithData(tiff).objectAtIndex(0);
  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  png.writeToFileAtomically('${outDir}/c8c-page-' + (i + 1) + '.png', true);
}
console.log('Rendered ' + pdfDoc.pageCount + ' pages');
"`;

  const renderOutput = execSync(jxaCmd, { encoding: 'utf-8' });
  console.log(renderOutput.trim());

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
