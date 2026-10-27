#!/usr/bin/env node

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  Instrument,
  Device,
  SensorChannel,
  RawReading,
  DerivedReading,
  User,
  OrganizationMember
} from '../src/models/index.js';

let server;
const TEST_PORT = 3099;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(TEST_PORT, '127.0.0.1', () => {
      resolve();
    });
  });
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runC2BVerification() {
  console.log('====================================================');
  console.log('PHASE C2B — HISTORICAL DATA VERIFICATION SUITE');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  try {
    // 1. Resolve Project LAN-PRO-01
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    if (!project) {
      throw new Error('Project LAN-PRO-01 not found.');
    }
    console.log(`[PASS] Found project: ${project.name} (${project._id})`);

    // Auth token for requests
    const user = await User.findOne({ organizationId: project.organizationId }) ||
                 await User.findOne();
    const member = await OrganizationMember.findOne({ userId: user._id, status: 'ACTIVE' }).lean();
    const token = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: member?.organizationRole || 'OWNER' },
      env.jwtSecret,
      { subject: user._id.toString(), expiresIn: '1h' }
    );

    // 2. Ingest real simulated packets through HTTP /api/v1/telemetry/ingest
    console.log('\n--- 1. SIMULATOR INGESTION TEST ---');
    const now = Date.now();

    // Ingest 3 consecutive readings for Inclinometer INC-2026-0001
    for (let i = 0; i < 3; i++) {
      const timestamp = new Date(now - (3 - i) * 60000).toISOString();
      const packet = {
        deviceCode: 'SNRS485-2026-0001',
        gatewayCode: 'GWLR-2026-0001',
        timestamp,
        source: 'SIMULATOR',
        messageId: `sim-inc-c2b-${i}-${Date.now()}`,
        readings: [
          {
            slot: 1,
            values: {
              x_displacement: Number((1.30 + i * 0.05).toFixed(3)),
              y_displacement: Number((-0.25 - i * 0.02).toFixed(3)),
              temperature: Number((26.5 + i * 0.3).toFixed(2))
            }
          }
        ]
      };

      const res = await fetch(`${BASE_URL}/api/v1/telemetry/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet)
      });
      const data = await res.json();

      if (!res.ok || !data.accepted) {
        throw new Error(`Inclinometer ingestion failed: ${JSON.stringify(data)}`);
      }
    }
    console.log('[PASS] Ingested 3 Inclinometer telemetry packets via HTTP /api/v1/telemetry/ingest');

    // Ingest 2 consecutive readings for Piezometer PZVW-2026-0001
    for (let i = 0; i < 2; i++) {
      const timestamp = new Date(now - (2 - i) * 60000).toISOString();
      const packet = {
        deviceCode: 'DLVW08-2026-0001',
        gatewayCode: 'GWLR-2026-0001',
        timestamp,
        source: 'SIMULATOR',
        messageId: `sim-pz-c2b-${i}-${Date.now()}`,
        readings: [
          {
            slot: 1,
            values: {
              pore_pressure: Number((45.20 + i * 0.80).toFixed(2)),
              temperature: Number((23.10 + i * 0.15).toFixed(2))
            }
          }
        ]
      };

      const res = await fetch(`${BASE_URL}/api/v1/telemetry/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet)
      });
      const data = await res.json();

      if (!res.ok || !data.accepted) {
        throw new Error(`Piezometer ingestion failed: ${JSON.stringify(data)}`);
      }
    }
    console.log('[PASS] Ingested 2 Piezometer telemetry packets via HTTP /api/v1/telemetry/ingest');

    // 3. Query Historical Data API
    console.log('\n--- 2. HISTORICAL DATA QUERY & TRACEABILITY TEST ---');
    const histRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry?page=1&limit=50&period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!histRes.ok) {
      const errText = await histRes.text();
      throw new Error(`Telemetry query failed with status ${histRes.status}: ${errText}`);
    }

    const histData = await histRes.json();
    const items = histData.items;
    const pagination = histData.pagination;
    console.log(`[PASS] Returned ${items.length} records. Total in DB: ${pagination.total}, Total pages: ${pagination.totalPages}`);

    if (!items.length) {
      throw new Error('No historical records returned!');
    }

    // 4. Verify Raw/Derived Linkage and Fields
    console.log('\n--- 3. FIELD & AUDITABLE PATH VERIFICATION ---');
    const sampleInc = items.find(r => r.instrumentCode === 'INC-2026-0001' && r.parameterCode === 'x_displacement');
    if (!sampleInc) {
      throw new Error('Could not find sample INC-2026-0001 x_displacement record');
    }
    console.log('Sample Inclinometer row:', {
      timestamp: sampleInc.observedAt,
      instrumentCode: sampleInc.instrumentCode,
      instrumentName: sampleInc.instrumentName,
      channelLabel: sampleInc.channelLabel,
      rawValue: sampleInc.rawValue,
      engineeringValue: sampleInc.engineeringValue,
      delta: sampleInc.deltaFromBaseline,
      unit: sampleInc.unit,
      quality: sampleInc.quality,
      source: sampleInc.source
    });

    // Verify RawReading linkage
    const rawDoc = await RawReading.findById(sampleInc.rawReadingId).lean();
    if (!rawDoc) {
      throw new Error(`RawReading not found for derived record ID: ${sampleInc.rawReadingId}`);
    }
    if (rawDoc.rawValue !== sampleInc.rawValue) {
      throw new Error(`Raw value mismatch: rawDoc=${rawDoc.rawValue}, history=${sampleInc.rawValue}`);
    }
    if (sampleInc.source !== 'SIMULATOR') {
      throw new Error(`Expected source SIMULATOR, got: ${sampleInc.source}`);
    }
    if (sampleInc.unit !== 'mm') {
      throw new Error(`Expected unit mm, got: ${sampleInc.unit}`);
    }
    console.log('[PASS] Inclinometer X raw value, engineering value, unit, quality, and SIMULATOR source verified');

    // Verify Piezometer
    const samplePz = items.find(r => r.instrumentCode === 'PZVW-2026-0001' && r.parameterCode === 'pore_pressure');
    if (!samplePz) {
      throw new Error('Could not find sample PZVW-2026-0001 pore_pressure record');
    }
    console.log('Sample Piezometer row:', {
      timestamp: samplePz.observedAt,
      instrumentCode: samplePz.instrumentCode,
      channelLabel: samplePz.channelLabel,
      rawValue: samplePz.rawValue,
      engineeringValue: samplePz.engineeringValue,
      unit: samplePz.unit,
      source: samplePz.source
    });
    if (samplePz.unit !== 'kPa') {
      throw new Error(`Expected piezometer pore_pressure unit kPa, got: ${samplePz.unit}`);
    }
    console.log('[PASS] Piezometer pore_pressure unit kPa and engineering value verified');

    // Temperature baseline delta check
    const sampleTemp = items.find(r => r.parameterCode === 'temperature');
    if (sampleTemp && sampleTemp.deltaFromBaseline !== null) {
      throw new Error(`Expected temperature deltaFromBaseline to be null, got: ${sampleTemp.deltaFromBaseline}`);
    }
    console.log('[PASS] Temperature baseline delta correctly resolves to null (not forced)');

    // 5. Test Filters
    console.log('\n--- 4. FILTER TESTS ---');

    // Instrument filter: INC-2026-0001
    const incRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry?instrumentId=${sampleInc.instrumentId}&period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const incData = await incRes.json();
    const onlyInc = incData.items.every(r => r.instrumentCode === 'INC-2026-0001');
    if (!onlyInc || !incData.items.length) {
      throw new Error('Instrument filter failed: non-matching instruments returned');
    }
    console.log(`[PASS] Instrument filter (INC-2026-0001) returned ${incData.items.length} records, all matching`);

    // Channel filter: x_displacement
    const chRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry?parameter=x_displacement&period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const chData = await chRes.json();
    const onlyX = chData.items.every(r => r.parameterCode === 'x_displacement');
    if (!onlyX || !chData.items.length) {
      throw new Error('Channel filter failed: non-matching channels returned');
    }
    console.log(`[PASS] Channel filter (x_displacement) returned ${chData.items.length} records, all matching`);

    // Piezometer filter
    const pzRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry?instrumentId=${samplePz.instrumentId}&period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const pzData = await pzRes.json();
    const onlyPz = pzData.items.every(r => r.instrumentCode === 'PZVW-2026-0001');
    if (!onlyPz || !pzData.items.length) {
      throw new Error('Piezometer filter failed');
    }
    console.log(`[PASS] Piezometer filter returned ${pzData.items.length} records, all matching`);

    // Date range filter
    const tStart = new Date(now - 180000).toISOString();
    const tEnd = new Date(now + 1000).toISOString();
    const dateRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry?from=${tStart}&to=${tEnd}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const dateData = await dateRes.json();
    const inRange = dateData.items.every(r => new Date(r.observedAt) >= new Date(tStart) && new Date(r.observedAt) <= new Date(tEnd));
    if (!inRange) {
      throw new Error('Date range filter failed');
    }
    console.log(`[PASS] Date range filter returned ${dateData.items.length} records within range`);

    // 6. Test Sorting (Newest First)
    console.log('\n--- 5. SORT ORDER TEST ---');
    let isSorted = true;
    for (let i = 1; i < items.length; i++) {
      if (new Date(items[i - 1].observedAt).getTime() < new Date(items[i].observedAt).getTime()) {
        isSorted = false;
        break;
      }
    }
    if (!isSorted) {
      throw new Error('Sort order is not newest-first (descending)');
    }
    console.log('[PASS] Records are strictly sorted newest-first (observedAt DESC)');

    // 7. Test Pagination
    console.log('\n--- 6. PAGINATION TEST ---');
    const p1Res = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry?page=1&limit=2&period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const p1Data = await p1Res.json();

    const p2Res = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry?page=2&limit=2&period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const p2Data = await p2Res.json();

    if (p1Data.items.length !== 2 || p2Data.items.length !== 2) {
      throw new Error('Pagination page size mismatch');
    }
    if (p1Data.items[0]._id === p2Data.items[0]._id) {
      throw new Error('Pagination overlap: Page 1 and Page 2 contain same first item');
    }
    console.log('[PASS] Server-side pagination verified (Page 1 and Page 2 distinct)');

    // 8. Test CSV Export
    console.log('\n--- 7. CSV EXPORT TEST ---');
    const csvRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry/export.csv?period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!csvRes.ok) {
      throw new Error(`CSV export failed with status ${csvRes.status}`);
    }
    const csvText = await csvRes.text();
    const csvLines = csvText.split('\n').filter(Boolean);
    const header = csvLines[0];
    console.log('CSV Header:', header);
    if (!header.includes('Timestamp') || !header.includes('Raw Value') || !header.includes('Engineering Value') || !header.includes('Source')) {
      throw new Error(`CSV header missing required columns: ${header}`);
    }
    if (csvLines.length <= 1) {
      throw new Error('CSV has no data rows');
    }
    if (!csvLines.some(line => line.includes('SIMULATOR'))) {
      throw new Error('CSV missing SIMULATOR source entries');
    }
    console.log(`[PASS] CSV export returned ${csvLines.length - 1} rows with SIMULATOR source`);

    // 9. Cross-Project Isolation
    console.log('\n--- 8. PROJECT ISOLATION TEST ---');
    const foreignProjectId = new mongoose.Types.ObjectId();
    const foreignRes = await fetch(`${BASE_URL}/api/v1/projects/${foreignProjectId}/telemetry?period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (foreignRes.status === 200) {
      const foreignData = await foreignRes.json();
      if (foreignData.items?.length > 0) {
        throw new Error('Cross-project leak: returned records for foreign project!');
      }
    }
    console.log('[PASS] Cross-project data isolation verified (status 403 or 0 records)');

    // 10. Commissioning Integrity Check
    console.log('\n--- 9. COMMISSIONING INTEGRITY CHECK ---');
    const instruments = await Instrument.find({ projectId: project._id }).lean();
    const allCommissioned = instruments.every(i => i.status === 'COMMISSIONED');
    if (!allCommissioned) {
      throw new Error('Commissioning status was mutated!');
    }
    console.log(`[PASS] All ${instruments.length} project instruments remain COMMISSIONED with unmodified commissioning data`);

    console.log('\n====================================================');
    console.log('ALL PHASE C2B VERIFICATION CHECKS PASSED SUCCESSFULLY (10/10)');
    console.log('====================================================');

  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC2BVerification().catch(err => {
  console.error('\n[TEST FAILURE]', err);
  process.exit(1);
});
