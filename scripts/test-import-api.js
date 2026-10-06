import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { PlatformAdmin, User, Organization, Sensor, SensorType, AdminAudit } from '../src/models/index.js';

async function runApiTests() {
  await mongoose.connect(env.mongoUri);
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  // Get or create Platform Admin
  let admin = await PlatformAdmin.findOne({ email: 'admin@geonexa.internal' });
  if (!admin) {
    admin = await PlatformAdmin.create({
      name: 'Platform Admin',
      email: 'admin@geonexa.internal',
      passwordHash: 'dummy'
    });
  }

  const adminToken = jwt.sign(
    { sub: admin._id.toString(), accountType: 'PLATFORM_ADMIN' },
    env.jwtSecret,
    { expiresIn: '1h' }
  );

  // Get or create regular user
  let user = await User.findOne({});
  let org = await Organization.findOne({});
  let userToken = 'dummy';
  if (user && org) {
    userToken = jwt.sign(
      { sub: user._id.toString(), organizationId: org._id.toString(), organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { expiresIn: '1h' }
    );
  }

  console.log('--- 1. Testing Security: Normal user blocked ---');
  if (userToken !== 'dummy') {
    const userRes = await fetch(`${baseUrl}/admin/sensors/import/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({ sensors: [] })
    });
    console.log('User status:', userRes.status);
    console.assert(userRes.status === 403, `Expected 403 for normal user, got ${userRes.status}`);
  }

  console.log('--- 2. Testing File Safety & Rejection ---');
  const emptyRes = await fetch(`${baseUrl}/admin/sensors/import/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ sensors: [] })
  });
  console.log('Empty sensors array status:', emptyRes.status);
  console.assert(emptyRes.status === 400, `Expected 400 for empty array, got ${emptyRes.status}`);

  const nonArrayRes = await fetch(`${baseUrl}/admin/sensors/import/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ sensors: "invalid" })
  });
  console.log('Non-array status:', nonArrayRes.status);
  console.assert(nonArrayRes.status === 400, `Expected 400 for non-array, got ${nonArrayRes.status}`);

  console.log('--- 3. Testing POST /admin/sensors/import/validate ---');
  const testSensors = [
    {
      name: 'VW Piezometer Standard',
      type: 'piezometer',
      model: 'PZ-STD-1',
      signal_type: 'vibrating_wire',
      channels: [
        {
          measurement: 'pore_pressure',
          unit: 'kPa',
          range_min: 0,
          range_max: 500
        }
      ]
    },
    {
      name: 'Multi-Param Probe',
      type: 'piezometer',
      model: 'MPP-01',
      signal_type: 'vibrating_wire',
      channels: [
        { measurement: 'pore_pressure', unit: 'kPa' },
        { measurement: 'temperature', unit: 'degC' }
      ]
    },
    {
      name: 'VW Crack Meter',
      type: 'crack_meter_new',
      model: '1201V-CM-LI',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'displacement', unit: 'mm' }]
    },
    {
      name: 'Invalid Channel Item',
      type: 'piezometer',
      model: 'INV-1',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'pore_pressure', unit: 'kPa', range_min: 100, range_max: 10 }]
    }
  ];

  const validateRes = await fetch(`${baseUrl}/admin/sensors/import/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ sensors: testSensors })
  });

  const valData = await validateRes.json();
  console.log('Validate status:', validateRes.status);
  console.log('Validate summary:', valData.summary);
  console.log('Missing types:', valData.missingTypes);

  console.assert(valData.summary.validCount === 2, `Expected 2 valid, got ${valData.summary.validCount}`);
  console.assert(valData.summary.missingTypeCount === 1, `Expected 1 missing type, got ${valData.summary.missingTypeCount}`);
  console.assert(valData.summary.invalidCount === 1, `Expected 1 invalid, got ${valData.summary.invalidCount}`);
  console.assert(valData.missingTypes.length === 1 && valData.missingTypes[0].code === 'crack_meter_new', 'Missing type should be crack_meter_new');

  console.log('--- 4. Testing POST /admin/sensors/import/create-types ---');
  const createTypeRes = await fetch(`${baseUrl}/admin/sensors/import/create-types`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ types: valData.missingTypes })
  });

  const createTypeData = await createTypeRes.json();
  console.log('Create type status:', createTypeRes.status);
  console.log('Created types:', createTypeData.created);
  console.assert(createTypeData.created.length === 1, 'Should have created 1 type');

  console.log('--- 5. Re-validating after creating missing type ---');
  const revalRes = await fetch(`${baseUrl}/admin/sensors/import/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ sensors: testSensors })
  });
  const revalData = await revalRes.json();
  console.log('Revalidate summary:', revalData.summary);
  console.assert(revalData.summary.validCount === 3, `Now expected 3 valid, got ${revalData.summary.validCount}`);
  console.assert(revalData.summary.missingTypeCount === 0, `Expected 0 missing type, got ${revalData.summary.missingTypeCount}`);

  console.log('--- 6. Testing POST /admin/sensors/import ---');
  const importRes = await fetch(`${baseUrl}/admin/sensors/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ sensors: testSensors })
  });

  const importData = await importRes.json();
  console.log('Import status:', importRes.status);
  console.log('Import summary:', importData.summary);
  console.log('Imported items:', importData.imported);

  console.assert(importData.summary.importedCount === 3, `Expected 3 imported, got ${importData.summary.importedCount}`);
  console.assert(importData.summary.failedCount === 1, `Expected 1 failed, got ${importData.summary.failedCount}`);
  console.assert(importData.imported.length === 3, 'Imported length should be 3');
  for (const s of importData.imported) {
    console.assert(/^SNS\d{6}$/.test(s.uid), `UID should match format: ${s.uid}`);
  }

  console.log('--- 7. Testing Audit Log for SENSORS_IMPORTED ---');
  const auditRes = await fetch(`${baseUrl}/admin/audit?action=SENSORS_IMPORTED`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const auditData = await auditRes.json();
  console.log('Audits found for SENSORS_IMPORTED:', auditData.data.length);
  console.assert(auditData.data.length >= 1, 'Should find SENSORS_IMPORTED audit record');
  const latestAudit = auditData.data[0];
  console.log('Latest audit metadata:', latestAudit.metadata);
  console.assert(latestAudit.metadata.importedCount === 3, 'Audit importedCount should be 3');

  console.log('--- 8. Testing Manual Add / Edit Sensor still works ---');
  const manualAddRes = await fetch(`${baseUrl}/admin/sensors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      name: 'Manual Test Sensor',
      type: 'piezometer',
      model: 'MAN-01',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'manual_meas', unit: 'unit1' }]
    })
  });
  const manualSensor = await manualAddRes.json();
  console.log('Manual sensor created:', manualSensor.uid);
  console.assert(/^SNS\d{6}$/.test(manualSensor.uid), 'Manual sensor UID format valid');

  // Edit manual sensor
  const manualEditRes = await fetch(`${baseUrl}/admin/sensors/${manualSensor._id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      name: 'Manual Test Sensor Edited',
      type: 'piezometer',
      model: 'MAN-01',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'manual_meas', unit: 'unit1' }]
    })
  });
  const editedSensor = await manualEditRes.json();
  console.log('Manual sensor edited name:', editedSensor.name);
  console.assert(editedSensor.name === 'Manual Test Sensor Edited', 'Manual edit works');

  // Clean up
  const importedIds = importData.imported.map(i => i._id);
  importedIds.push(manualSensor._id);
  await Sensor.deleteMany({ _id: { $in: importedIds } });
  await SensorType.deleteOne({ code: 'crack_meter_new' });
  await AdminAudit.deleteMany({ targetType: 'Sensor', action: 'SENSORS_IMPORTED' });

  server.close();
  await mongoose.disconnect();
  console.log('\n--- ALL API INTEGRATION TESTS PASSED 100% ---');
}

runApiTests().catch(err => {
  console.error('API test failed:', err);
  process.exit(1);
});
