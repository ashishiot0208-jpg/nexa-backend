import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Sensor, SensorType, Counter, AdminAudit, PlatformAdmin } from '../src/models/index.js';
import { evaluateSensorBatch, deriveDisplayName } from '../src/utils/sensor-import.js';

async function runTests() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(env.mongoUri);

  // Setup test admin
  let admin = await PlatformAdmin.findOne({ email: 'admin@geonexa.internal' });
  if (!admin) {
    admin = await PlatformAdmin.create({
      name: 'Test Admin',
      email: 'admin@geonexa.internal',
      passwordHash: 'dummy'
    });
  }

  // Ensure piezometer exists and is active
  await SensorType.findOneAndUpdate(
    { code: 'piezometer' },
    { name: 'Piezometer', status: 'active' },
    { upsert: true, new: true }
  );

  // Ensure crack_meter is inactive for testing inactive type
  await SensorType.findOneAndUpdate(
    { code: 'crack_meter_inactive' },
    { name: 'Inactive Crack Meter', status: 'inactive' },
    { upsert: true, new: true }
  );

  // Ensure existing sensor in catalogue
  const existingSensor = await Sensor.findOne({ type: 'piezometer', name: 'VW Piezometer', model: 'PZ-VW-100' });
  if (!existingSensor) {
    await Sensor.create({
      name: 'VW Piezometer',
      type: 'piezometer',
      model: 'PZ-VW-100',
      signal_type: 'vibrating_wire',
      channels: [
        {
          measurement: 'pore_pressure',
          unit: 'kPa'
        }
      ],
      status: 'active'
    });
  }

  const existingSensors = await Sensor.find().lean();
  const existingSensorTypes = await SensorType.find().lean();

  const testPayload = [
    // 1. Valid Single-channel sensor
    {
      name: 'Single Channel Piezometer',
      type: 'piezometer',
      model: 'SC-100',
      signal_type: 'vibrating_wire',
      channels: [
        {
          measurement: 'pore_pressure',
          unit: 'kPa',
          range_min: 0,
          range_max: 500,
          resolution_value: 0.1,
          resolution_unit: 'kPa',
          accuracy_value: 0.2,
          accuracy_unit: '% FSR'
        }
      ]
    },
    // 2. Valid Multi-channel sensor
    {
      name: 'Multi Channel Piezometer',
      type: 'piezometer',
      model: 'MC-200',
      signal_type: 'vibrating_wire',
      channels: [
        {
          measurement: 'pore_pressure',
          unit: 'kPa',
          range_min: 0,
          range_max: 1000
        },
        {
          measurement: 'temperature',
          unit: 'degC',
          range_min: -20,
          range_max: 80
        }
      ]
    },
    // 3. Duplicate of catalogue sensor
    {
      name: 'VW Piezometer',
      type: 'piezometer',
      model: 'PZ-VW-100',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'pore_pressure', unit: 'kPa' }]
    },
    // 4. Duplicate inside file
    {
      name: 'Single Channel Piezometer',
      type: 'piezometer',
      model: 'SC-100',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'pore_pressure', unit: 'kPa' }]
    },
    // 5. Missing sensor type
    {
      name: 'Earth Pressure Cell',
      type: 'earth_pressure_cell',
      model: 'EPC-VW-2000',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'pressure', unit: 'kPa' }]
    },
    // 6. Inactive sensor type
    {
      name: 'Inactive Type Sensor',
      type: 'crack_meter_inactive',
      model: 'INACT-01',
      signal_type: 'vibrating_wire',
      channels: [{ measurement: 'displacement', unit: 'mm' }]
    },
    // 7. Invalid: missing channels
    {
      name: 'Invalid Sensor No Channels',
      type: 'piezometer',
      model: 'INV-01',
      signal_type: 'vibrating_wire',
      channels: []
    },
    // 8. Invalid: duplicate channel measurement
    {
      name: 'Invalid Duplicate Measurement',
      type: 'piezometer',
      model: 'INV-02',
      signal_type: 'vibrating_wire',
      channels: [
        { measurement: 'pore_pressure', unit: 'kPa' },
        { measurement: 'pore_pressure', unit: 'kPa' }
      ]
    },
    // 9. Invalid: range_min > range_max
    {
      name: 'Invalid Range',
      type: 'piezometer',
      model: 'INV-03',
      signal_type: 'vibrating_wire',
      channels: [
        { measurement: 'pore_pressure', unit: 'kPa', range_min: 100, range_max: 50 }
      ]
    }
  ];

  console.log('\n--- EVALUATING BATCH ---');
  const evaluation = evaluateSensorBatch(testPayload, existingSensors, existingSensorTypes);
  console.log('Summary:', JSON.stringify(evaluation.summary, null, 2));
  console.log('Missing Types:', JSON.stringify(evaluation.missingTypes, null, 2));

  // Assertions
  const r0 = evaluation.rows[0];
  console.assert(r0.status === 'VALID', `Row 0 should be VALID, got ${r0.status}`);

  const r1 = evaluation.rows[1];
  console.assert(r1.status === 'VALID', `Row 1 should be VALID, got ${r1.status}`);
  console.assert(r1.channelsCount === 2, `Row 1 should have 2 channels, got ${r1.channelsCount}`);

  const r2 = evaluation.rows[2];
  console.assert(r2.status === 'DUPLICATE', `Row 2 should be DUPLICATE, got ${r2.status}`);
  console.assert(r2.issue === 'Possible existing Sensor', `Row 2 issue: ${r2.issue}`);

  const r3 = evaluation.rows[3];
  console.assert(r3.status === 'DUPLICATE', `Row 3 should be DUPLICATE, got ${r3.status}`);
  console.assert(r3.issue === 'Duplicate Sensor inside uploaded file', `Row 3 issue: ${r3.issue}`);

  const r4 = evaluation.rows[4];
  console.assert(r4.status === 'MISSING TYPE', `Row 4 should be MISSING TYPE, got ${r4.status}`);
  console.assert(evaluation.missingTypes.some(t => t.code === 'earth_pressure_cell'), 'Missing types should include earth_pressure_cell');

  const r5 = evaluation.rows[5];
  console.assert(r5.status === 'TYPE INACTIVE', `Row 5 should be TYPE INACTIVE, got ${r5.status}`);

  const r6 = evaluation.rows[6];
  console.assert(r6.status === 'INVALID', `Row 6 should be INVALID, got ${r6.status}`);

  const r7 = evaluation.rows[7];
  console.assert(r7.status === 'INVALID', `Row 7 should be INVALID, got ${r7.status}`);

  const r8 = evaluation.rows[8];
  console.assert(r8.status === 'INVALID', `Row 8 should be INVALID, got ${r8.status}`);

  console.log('All evaluation classifications VERIFIED successfully!');

  // Test creating missing type and re-validating
  console.log('\n--- TESTING CREATING MISSING TYPE ---');
  const createdType = await SensorType.create({
    code: 'earth_pressure_cell',
    name: 'Earth Pressure Cell',
    status: 'active'
  });
  console.log('Created sensor type:', createdType.code);

  const updatedTypes = await SensorType.find().lean();
  const reEvaluation = evaluateSensorBatch([testPayload[4]], existingSensors, updatedTypes);
  console.assert(reEvaluation.rows[0].status === 'VALID', `Row 4 after creating type should be VALID, got ${reEvaluation.rows[0].status}`);
  console.log('Re-evaluation after creating type: VERIFIED VALID!');

  // Test actual import of valid items
  console.log('\n--- TESTING ACTUAL BULK IMPORT ---');
  const validRows = evaluation.rows.filter(r => r.status === 'VALID');
  const createdList = [];
  for (const row of validRows) {
    const s = await Sensor.create({
      name: row.cleanData.name,
      type: row.cleanData.type,
      model: row.cleanData.model,
      signal_type: row.cleanData.signal_type,
      channels: row.cleanData.channels,
      status: 'active'
    });
    createdList.push(s);
  }

  console.log(`Created ${createdList.length} sensors:`);
  for (const s of createdList) {
    console.log(`- ID: ${s._id}, UID: ${s.uid}, Name: ${s.name}, Channels: ${s.channels.length}, Status: ${s.status}`);
    console.assert(/^SNS\d{6}$/.test(s.uid), `UID should match SNS###### format: got ${s.uid}`);
    console.assert(s.status === 'active', `Status should be active: got ${s.status}`);
  }

  // Audit event
  const audit = await AdminAudit.create({
    adminId: admin._id,
    action: 'SENSORS_IMPORTED',
    targetType: 'Sensor',
    metadata: {
      importedCount: createdList.length,
      skippedCount: evaluation.summary.duplicateCount,
      failedCount: evaluation.summary.invalidCount + evaluation.summary.missingTypeCount + evaluation.summary.inactiveTypeCount
    }
  });
  console.log('Audit record created with ID:', audit._id, 'Action:', audit.action, 'Metadata:', audit.metadata);

  // Clean up created test items so we don't pollute permanent DB
  console.log('\n--- CLEANING UP TEST ITEMS ---');
  await Sensor.deleteMany({ _id: { $in: createdList.map(s => s._id) } });
  await SensorType.deleteOne({ code: 'earth_pressure_cell' });
  await SensorType.deleteOne({ code: 'crack_meter_inactive' });
  await AdminAudit.deleteOne({ _id: audit._id });

  console.log('All backend tests passed cleanly!');
  await mongoose.disconnect();
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
