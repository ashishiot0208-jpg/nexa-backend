import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Project, User, Instrument, Investigation } from '../src/models/index.js';

let server;
const TEST_PORT = 3126;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  console.log('Connected to MongoDB');

  const app = createApp();
  await new Promise(resolve => {
    server = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });
  console.log(`Test server running on port ${TEST_PORT}`);

  try {
    const project = await Project.findOne({ code: 'LAN-PRO-01' }).lean();
    if (!project) throw new Error('Project LAN-PRO-01 not found');

    let adminUser = await User.findOne({ email: 'admin@geonexa.test' }) || await User.findOne();
    const token = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: adminUser._id.toString(), expiresIn: '1h' }
    );

    const headers = { Authorization: `Bearer ${token}` };

    const inst = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' }).lean();
    const inv = await Investigation.findOne({ projectId: project._id }).lean();

    const tests = [
      { name: 'Monitoring Summary PDF', url: `/api/v1/projects/${project._id}/reports/monitoring-summary/pdf`, type: 'application/pdf' },
      { name: 'Monitoring Summary CSV', url: `/api/v1/projects/${project._id}/reports/monitoring-summary/csv`, type: 'text/csv' },
      { name: 'Instrument Trend PDF', url: `/api/v1/projects/${project._id}/reports/instrument-trend/pdf?instrumentId=${inst?._id}&parameterCode=x_displacement`, type: 'application/pdf' },
      { name: 'Instrument Trend CSV', url: `/api/v1/projects/${project._id}/reports/instrument-trend/csv?instrumentId=${inst?._id}&parameterCode=x_displacement`, type: 'text/csv' },
      { name: 'Alarm History PDF', url: `/api/v1/projects/${project._id}/reports/alarms/pdf`, type: 'application/pdf' },
      { name: 'Alarm History CSV', url: `/api/v1/projects/${project._id}/reports/alarms/csv`, type: 'text/csv' },
      { name: 'Investigation Summary PDF', url: `/api/v1/projects/${project._id}/reports/investigations/pdf`, type: 'application/pdf' },
      { name: 'Investigation Summary CSV', url: `/api/v1/projects/${project._id}/reports/investigations/csv`, type: 'text/csv' },
      { name: 'Infrastructure Health PDF', url: `/api/v1/projects/${project._id}/reports/infrastructure/pdf`, type: 'application/pdf' },
      { name: 'Infrastructure Health CSV', url: `/api/v1/projects/${project._id}/reports/infrastructure/csv`, type: 'text/csv' },
      { name: 'Severity Summary PDF', url: `/api/v1/projects/${project._id}/reports/severity/pdf`, type: 'application/pdf' },
      { name: 'Severity Summary CSV', url: `/api/v1/projects/${project._id}/reports/severity/csv`, type: 'text/csv' },
      { name: 'Generic Export Route PDF', url: `/api/v1/projects/${project._id}/reports/export?type=monitoring-summary&format=pdf`, type: 'application/pdf' }
    ];

    if (inv) {
      tests.push({
        name: 'Single Investigation Detail PDF',
        url: `/api/v1/projects/${project._id}/reports/investigations/${inv._id}/pdf`,
        type: 'application/pdf'
      });
    }

    console.log(`\nTesting ${tests.length} export endpoints...`);
    for (const t of tests) {
      const res = await fetch(`${BASE_URL}${t.url}`, { headers });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`[FAIL] ${t.name} returned HTTP ${res.status}: ${err}`);
      }
      const ct = res.headers.get('content-type');
      const cd = res.headers.get('content-disposition');
      if (!ct || !ct.includes(t.type)) {
        throw new Error(`[FAIL] ${t.name} expected ${t.type}, got ${ct}`);
      }
      if (!cd || !cd.includes('attachment') || !cd.includes('filename=')) {
        throw new Error(`[FAIL] ${t.name} missing Content-Disposition attachment header: ${cd}`);
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 50) {
        throw new Error(`[FAIL] ${t.name} generated empty or too small output (${buf.byteLength} bytes)`);
      }
      console.log(`[PASS] ${t.name}: ${buf.byteLength} bytes (${ct}) -> ${cd}`);
    }

    console.log('\n========================================');
    console.log('ALL EXPORT ENDPOINTS VERIFIED SUCCESSFULLY');
    console.log('========================================');
  } finally {
    if (server) await new Promise(res => server.close(res));
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
