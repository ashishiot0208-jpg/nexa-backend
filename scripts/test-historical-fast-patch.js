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
  User,
  OrganizationMember
} from '../src/models/index.js';

let server;
const TEST_PORT = 3098;
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

async function runPatchVerification() {
  console.log('====================================================');
  console.log('FAST PATCH — HISTORICAL DATA FILTER & CSV EXPORT TEST');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  try {
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    if (!project) throw new Error('Project LAN-PRO-01 not found.');
    console.log(`[PASS] Found project: ${project.name} (${project._id})`);

    const user = await User.findOne({ organizationId: project.organizationId }) || await User.findOne();
    const member = await OrganizationMember.findOne({ userId: user._id, status: 'ACTIVE' }).lean();
    const token = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: member?.organizationRole || 'OWNER' },
      env.jwtSecret,
      { subject: user._id.toString(), expiresIn: '1h' }
    );

    // ----------------------------------------------------
    // TEST 1: CSV Export Authentication Security
    // ----------------------------------------------------
    console.log('\n--- 1. CSV EXPORT AUTHENTICATION SECURITY ---');
    // Without auth header
    const unauthRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry/export.csv`);
    const unauthBody = await unauthRes.json();
    if (unauthRes.status !== 401 || unauthBody.message !== 'AuthReq') {
      throw new Error(`Expected 401 AuthReq for unauthenticated export, got: ${unauthRes.status} ${JSON.stringify(unauthBody)}`);
    }
    console.log('[PASS] Unauthenticated CSV request blocked with 401 AuthReq');

    // With Bearer auth header
    const authRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/telemetry/export.csv?period=ALL`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!authRes.ok) {
      throw new Error(`Authenticated export failed with status ${authRes.status}`);
    }
    const contentType = authRes.headers.get('content-type');
    const contentDisp = authRes.headers.get('content-disposition');
    if (!contentType?.includes('text/csv')) {
      throw new Error(`Expected text/csv content type, got: ${contentType}`);
    }
    if (!contentDisp?.includes('LAN-PRO-01-historical-data-') && !contentDisp?.includes('attachment')) {
      throw new Error(`Expected valid Content-Disposition with project filename, got: ${contentDisp}`);
    }
    const csvText = await authRes.text();
    console.log(`[PASS] Authenticated CSV export succeeded (Content-Type: ${contentType}, Content-Disposition: ${contentDisp})`);
    console.log(`[PASS] CSV Header: ${csvText.split('\n')[0]}`);

    // ----------------------------------------------------
    // TEST 2: Controlled Date Range Telemetry Ingestion
    // ----------------------------------------------------
    console.log('\n--- 2. CONTROLLED DATE RANGE INGESTION VIA SIMULATOR ---');
    const now = Date.now();
    const testPoints = [
      { id: 'point-A', daysAgo: 2, val: 1.111 },   // 2 days ago -> within 7 days, 30 days, 90 days, ALL
      { id: 'point-B', daysAgo: 15, val: 1.222 },  // 15 days ago -> within 30 days, 90 days, ALL
      { id: 'point-C', daysAgo: 60, val: 1.333 },  // 60 days ago -> within 90 days, ALL
      { id: 'point-D', daysAgo: 120, val: 1.444 }  // 120 days ago -> only within ALL
    ];

    for (const pt of testPoints) {
      const sampleTime = new Date(now - pt.daysAgo * 24 * 3600000).toISOString();
      const packet = {
        deviceCode: 'SNRS485-2026-0001',
        gatewayCode: 'GWLR-2026-0001',
        timestamp: sampleTime,
        source: 'SIMULATOR',
        messageId: `date-test-${pt.id}-${Date.now()}`,
        readings: [
          {
            slot: 1,
            values: {
              x_displacement: pt.val
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
        throw new Error(`Ingestion failed for ${pt.id}: ${JSON.stringify(data)}`);
      }
      console.log(`[PASS] Ingested ${pt.id} at ${sampleTime} (${pt.daysAgo} days ago) value=${pt.val}`);
    }

    // ----------------------------------------------------
    // TEST 3: Range Filter Verification (7 days, 30 days, 90 days, ALL)
    // ----------------------------------------------------
    console.log('\n--- 3. DATE RANGE BACKEND QUERY VERIFICATION ---');

    async function queryRange(period) {
      const res = await fetch(
        `${BASE_URL}/api/v1/projects/${project._id}/telemetry?period=${encodeURIComponent(period)}&parameter=x_displacement&limit=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Query failed for period ${period}: ${res.status}`);
      const body = await res.json();
      return body.items || [];
    }

    const items7d = await queryRange('7 days');
    const items30d = await queryRange('30 days');
    const items90d = await queryRange('90 days');
    const itemsAll = await queryRange('All');

    const hasA = (items) => items.some(x => x.engineeringValue === 1.111);
    const hasB = (items) => items.some(x => x.engineeringValue === 1.222);
    const hasC = (items) => items.some(x => x.engineeringValue === 1.333);
    const hasD = (items) => items.some(x => x.engineeringValue === 1.444);

    // 7 days must have A, but NOT B, C, D
    if (!hasA(items7d)) throw new Error('7 days filter missing Point A (2 days ago)');
    if (hasB(items7d)) throw new Error('7 days filter incorrectly contains Point B (15 days ago)');
    if (hasC(items7d)) throw new Error('7 days filter incorrectly contains Point C (60 days ago)');
    if (hasD(items7d)) throw new Error('7 days filter incorrectly contains Point D (120 days ago)');
    console.log('[PASS] 7 days filter: correctly includes A (2d), excludes B (15d), C (60d), D (120d)');

    // 30 days must have A and B, but NOT C, D
    if (!hasA(items30d) || !hasB(items30d)) throw new Error('30 days filter missing Point A or B');
    if (hasC(items30d)) throw new Error('30 days filter incorrectly contains Point C (60 days ago)');
    if (hasD(items30d)) throw new Error('30 days filter incorrectly contains Point D (120 days ago)');
    console.log('[PASS] 30 days filter: correctly includes A (2d) and B (15d), excludes C (60d), D (120d)');

    // 90 days must have A, B, C, but NOT D
    if (!hasA(items90d) || !hasB(items90d) || !hasC(items90d)) throw new Error('90 days filter missing Point A, B, or C');
    if (hasD(items90d)) throw new Error('90 days filter incorrectly contains Point D (120 days ago)');
    console.log('[PASS] 90 days filter: correctly includes A (2d), B (15d), C (60d), excludes D (120d)');

    // ALL must have A, B, C, D
    if (!hasA(itemsAll) || !hasB(itemsAll) || !hasC(itemsAll) || !hasD(itemsAll)) {
      throw new Error('All filter missing points');
    }
    console.log('[PASS] All filter: correctly includes A (2d), B (15d), C (60d), and D (120d)');

    // ----------------------------------------------------
    // TEST 4: CSV Export Filter Respect Test
    // ----------------------------------------------------
    console.log('\n--- 4. CSV EXPORT RESPECTS ACTIVE FILTERS ---');
    const csv7dRes = await fetch(
      `${BASE_URL}/api/v1/projects/${project._id}/telemetry/export.csv?period=7%20days&parameter=x_displacement`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const csv7dText = await csv7dRes.text();
    if (!csv7dText.includes('1.111')) throw new Error('CSV 7 days missing Point A');
    if (csv7dText.includes('1.222') || csv7dText.includes('1.333') || csv7dText.includes('1.444')) {
      throw new Error('CSV 7 days contains older records beyond 7 days');
    }
    console.log('[PASS] CSV export respects 7 days filter (only 1.111 present)');

    const csvAllRes = await fetch(
      `${BASE_URL}/api/v1/projects/${project._id}/telemetry/export.csv?period=All&parameter=x_displacement`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const csvAllText = await csvAllRes.text();
    if (!csvAllText.includes('1.111') || !csvAllText.includes('1.222') || !csvAllText.includes('1.333') || !csvAllText.includes('1.444')) {
      throw new Error('CSV All missing some historical data points');
    }
    console.log('[PASS] CSV export respects All filter (contains 1.111, 1.222, 1.333, 1.444)');

    // ----------------------------------------------------
    // TEST 5: Deterministic Sort & Pagination
    // ----------------------------------------------------
    console.log('\n--- 5. SORT ORDER & PAGINATION ---');
    const page1Res = await fetch(
      `${BASE_URL}/api/v1/projects/${project._id}/telemetry?period=All&parameter=x_displacement&page=1&limit=2`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const page1 = await page1Res.json();
    const page2Res = await fetch(
      `${BASE_URL}/api/v1/projects/${project._id}/telemetry?period=All&parameter=x_displacement&page=2&limit=2`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const page2 = await page2Res.json();
    if (page1.items[0]._id === page2.items[0]._id) {
      throw new Error('Pagination page 1 and page 2 returned same items');
    }
    const t0 = new Date(page1.items[0].timestamp).getTime();
    const t1 = new Date(page1.items[1].timestamp).getTime();
    if (t0 < t1) throw new Error('Items not sorted newest first');
    console.log('[PASS] Server-side pagination and deterministic newest-first sort verified');

    // ----------------------------------------------------
    // TEST 6: Commissioning Integrity Check
    // ----------------------------------------------------
    console.log('\n--- 6. COMMISSIONING INTEGRITY CHECK ---');
    const commissionedCount = await Instrument.countDocuments({ projectId: project._id, status: 'COMMISSIONED' });
    if (commissionedCount !== 6) throw new Error(`Expected 6 commissioned instruments, found: ${commissionedCount}`);
    console.log(`[PASS] Commissioned instruments count intact: ${commissionedCount}`);

    console.log('\n====================================================');
    console.log('ALL FAST PATCH CHECKS PASSED (6/6)');
    console.log('====================================================\n');
  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runPatchVerification().catch(err => {
  console.error('\n[TEST FAILURE]', err);
  process.exit(1);
});
