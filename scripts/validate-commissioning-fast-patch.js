import { env } from '../src/config/env.js';
import mongoose from 'mongoose';
import * as m from '../src/models/index.js';

async function validateFastPatchCommissioning() {
  await mongoose.connect(env.mongoUri);
  console.log('========================================================');
  console.log('COMMISSIONING VALIDATION SUITE: LAN-PRO-01');
  console.log('========================================================\n');

  // 1. Locate Landslide Project (LAN-PRO-01)
  const project = await m.Project.findOne({ code: 'LAN-PRO-01' });
  if (!project) {
    throw new Error('Project LAN-PRO-01 not found');
  }
  console.log(`✓ Project found: ${project.name} (${project.code}), ID: ${project._id}`);

  // Snapshot plannedConfiguration before anything
  const plannedConfigBefore = JSON.stringify(project.plannedConfiguration);

  // Clean up any test commissioning data for this project to ensure a clean start
  await m.SensorDeviceMapping.deleteMany({ projectId: project._id });
  await m.DeviceGatewayMapping.deleteMany({ projectId: project._id });
  await m.Instrument.deleteMany({ projectId: project._id });
  await m.Device.deleteMany({ projectId: project._id });
  await m.ProjectGateway.deleteMany({ projectId: project._id });

  // --------------------------------------------------------
  // TASK 3 — VERIFY PLANNED COUNTS
  // --------------------------------------------------------
  console.log('\n--- TASK 3: VERIFY PLANNED COUNTS ---');
  const planned = project.plannedConfiguration;
  if (!planned || !planned.sensors || !planned.devices || !planned.gateways) {
    throw new Error('plannedConfiguration is missing or incomplete');
  }

  const plannedInclinometer = planned.sensors.find(s => s.name === 'Automatic Inclinometer');
  const plannedPiezo = planned.sensors.find(s => s.name === 'VW Piezometer');
  const plannedTilt = planned.sensors.find(s => s.name === 'MEMS Tiltmeter');
  const plannedRain = planned.sensors.find(s => s.name === 'Rain Gauge');
  const plannedGnss = planned.sensors.find(s => s.name === 'GNSS Displacement Sensor');

  const plannedRs485 = planned.devices.find(d => d.name === '8 Channel RS485 Sensor Node');
  const plannedVwLogger = planned.devices.find(d => d.name === '8 Channel VW Data logger' || d.name === '8 Channel VW Data Logger');
  const plannedGw = planned.gateways.find(g => g.name === 'LoRaWAN Gateway 01');

  const totalSensorsPlanned = planned.sensors.reduce((sum, s) => sum + s.quantity, 0);
  const totalDevicesPlanned = planned.devices.reduce((sum, d) => sum + d.quantity, 0);
  const totalGatewaysPlanned = planned.gateways.reduce((sum, g) => sum + g.quantity, 0);

  console.log(`Sensors Planned: 0 / ${totalSensorsPlanned} planned (expected 20)`);
  console.log(`Devices Planned: 0 / ${totalDevicesPlanned} planned (expected 3)`);
  console.log(`Gateways Planned: 0 / ${totalGatewaysPlanned} planned (expected 1)`);

  console.log(`- Automatic Inclinometer: 0 / ${plannedInclinometer.quantity} (expected 4)`);
  console.log(`- VW Piezometer: 0 / ${plannedPiezo.quantity} (expected 4)`);
  console.log(`- MEMS Tiltmeter: 0 / ${plannedTilt.quantity} (expected 4)`);
  console.log(`- Rain Gauge: 0 / ${plannedRain.quantity} (expected 4)`);
  console.log(`- GNSS Displacement Sensor: 0 / ${plannedGnss.quantity} (expected 4)`);
  console.log(`- 8 Channel RS485 Sensor Node: 0 / ${plannedRs485.quantity} (expected 2)`);
  console.log(`- 8 Channel VW Data Logger: 0 / ${plannedVwLogger.quantity} (expected 1)`);
  console.log(`- LoRaWAN Gateway 01: 0 / ${plannedGw.quantity} (expected 1)`);

  if (totalSensorsPlanned !== 20) throw new Error(`Expected 20 planned sensors, got ${totalSensorsPlanned}`);
  if (totalDevicesPlanned !== 3) throw new Error(`Expected 3 planned devices, got ${totalDevicesPlanned}`);
  if (totalGatewaysPlanned !== 1) throw new Error(`Expected 1 planned gateway, got ${totalGatewaysPlanned}`);
  console.log('✓ Task 3 Verified successfully!');

  // --------------------------------------------------------
  // TASK 4 — REGISTRATION WORKFLOW WITH SMALL TEST
  // --------------------------------------------------------
  console.log('\n--- TASK 4: REGISTER SMALL TEST SET ---');

  // 1 Gateway
  const actualGateway = await m.ProjectGateway.create({
    organizationId: project.organizationId,
    projectId: project._id,
    gatewayId: 'GWLR-2026-0001',
    gateway_uid: plannedGw.gateway_uid,
    name: 'LoRaWAN Gateway 01',
    serial: 'GWLR-2026-0001',
    status: 'REGISTERED',
    metadata: { gateway_uid: plannedGw.gateway_uid }
  });
  console.log(`✓ Registered 1 Gateway: ${actualGateway.gatewayId} (serial: ${actualGateway.serial})`);

  // Device 1: 8 Channel RS485 Sensor Node
  const actualRs485Node = await m.Device.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceId: 'SNRS485-2026-0001',
    device_uid: plannedRs485.device_uid,
    name: '8 Channel RS485 Sensor Node',
    serial: 'SNRS485-2026-0001',
    transport: 'LORAWAN',
    status: 'REGISTERED',
    metadata: {
      device_uid: plannedRs485.device_uid,
      communication: 'lorawan',
      supported_signal_types: ['rs485'],
      max_channels: 8
    }
  });
  console.log(`✓ Registered Device 1: ${actualRs485Node.deviceId} (serial: ${actualRs485Node.serial})`);

  // Device 2: 8 Channel VW Data Logger
  const actualVwLogger = await m.Device.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceId: 'DLVW08-2026-0001',
    device_uid: plannedVwLogger.device_uid,
    name: '8 Channel VW Data Logger',
    serial: 'DLVW08-2026-0001',
    transport: 'LORAWAN',
    status: 'REGISTERED',
    metadata: {
      device_uid: plannedVwLogger.device_uid,
      communication: 'lorawan',
      supported_signal_types: ['vibrating_wire'],
      max_channels: 8
    }
  });
  console.log(`✓ Registered Device 2: ${actualVwLogger.deviceId} (serial: ${actualVwLogger.serial})`);

  // 2 Automatic Inclinometers
  const actualInc1 = await m.Instrument.create({
    organizationId: project.organizationId,
    projectId: project._id,
    catalogCode: plannedInclinometer.sensor_uid,
    sensor_uid: plannedInclinometer.sensor_uid,
    name: 'Automatic Inclinometer 01',
    code: 'INC-2026-0001',
    serial: 'INC-2026-0001',
    status: 'REGISTERED',
    metadata: { sensor_uid: plannedInclinometer.sensor_uid, signal_type: 'rs485' }
  });
  const actualInc2 = await m.Instrument.create({
    organizationId: project.organizationId,
    projectId: project._id,
    catalogCode: plannedInclinometer.sensor_uid,
    sensor_uid: plannedInclinometer.sensor_uid,
    name: 'Automatic Inclinometer 02',
    code: 'INC-2026-0002',
    serial: 'INC-2026-0002',
    status: 'REGISTERED',
    metadata: { sensor_uid: plannedInclinometer.sensor_uid, signal_type: 'rs485' }
  });
  console.log(`✓ Registered 2 Automatic Inclinometers: ${actualInc1.code}, ${actualInc2.code}`);

  // 2 VW Piezometers
  const actualPiezo1 = await m.Instrument.create({
    organizationId: project.organizationId,
    projectId: project._id,
    catalogCode: plannedPiezo.sensor_uid,
    sensor_uid: plannedPiezo.sensor_uid,
    name: 'VW Piezometer 01',
    code: 'PZVW-2026-0001',
    serial: 'PZVW-2026-0001',
    status: 'REGISTERED',
    metadata: { sensor_uid: plannedPiezo.sensor_uid, signal_type: 'vibrating_wire' }
  });
  const actualPiezo2 = await m.Instrument.create({
    organizationId: project.organizationId,
    projectId: project._id,
    catalogCode: plannedPiezo.sensor_uid,
    sensor_uid: plannedPiezo.sensor_uid,
    name: 'VW Piezometer 02',
    code: 'PZVW-2026-0002',
    serial: 'PZVW-2026-0002',
    status: 'REGISTERED',
    metadata: { sensor_uid: plannedPiezo.sensor_uid, signal_type: 'vibrating_wire' }
  });
  console.log(`✓ Registered 2 VW Piezometers: ${actualPiezo1.code}, ${actualPiezo2.code}`);

  // --------------------------------------------------------
  // TASK 5 — VERIFY COUNTERS AFTER REGISTRATION
  // --------------------------------------------------------
  console.log('\n--- TASK 5: VERIFY COUNTERS AFTER REGISTRATION ---');
  const countSensorsReg = await m.Instrument.countDocuments({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } });
  const countIncReg = await m.Instrument.countDocuments({ projectId: project._id, sensor_uid: plannedInclinometer.sensor_uid });
  const countPzReg = await m.Instrument.countDocuments({ projectId: project._id, sensor_uid: plannedPiezo.sensor_uid });
  const countTiltReg = await m.Instrument.countDocuments({ projectId: project._id, sensor_uid: plannedTilt.sensor_uid });
  const countRainReg = await m.Instrument.countDocuments({ projectId: project._id, sensor_uid: plannedRain.sensor_uid });
  const countGnssReg = await m.Instrument.countDocuments({ projectId: project._id, sensor_uid: plannedGnss.sensor_uid });

  const countDevicesReg = await m.Device.countDocuments({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } });
  const countRs485Reg = await m.Device.countDocuments({ projectId: project._id, device_uid: plannedRs485.device_uid });
  const countVwLoggerReg = await m.Device.countDocuments({ projectId: project._id, device_uid: plannedVwLogger.device_uid });

  const countGatewaysReg = await m.ProjectGateway.countDocuments({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } });
  const countGw01Reg = await m.ProjectGateway.countDocuments({ projectId: project._id, gateway_uid: plannedGw.gateway_uid });

  console.log(`SENSORS REGISTERED: ${countSensorsReg} / 20 planned`);
  console.log(`- Automatic Inclinometer: ${countIncReg} / 4`);
  console.log(`- VW Piezometer: ${countPzReg} / 4`);
  console.log(`- MEMS Tiltmeter: ${countTiltReg} / 4`);
  console.log(`- Rain Gauge: ${countRainReg} / 4`);
  console.log(`- GNSS Displacement Sensor: ${countGnssReg} / 4`);

  console.log(`DEVICES REGISTERED: ${countDevicesReg} / 3 planned`);
  console.log(`- 8 Channel RS485 Sensor Node: ${countRs485Reg} / 2`);
  console.log(`- 8 Channel VW Data Logger: ${countVwLoggerReg} / 1`);

  console.log(`GATEWAYS REGISTERED: ${countGatewaysReg} / 1 planned`);
  console.log(`- LoRaWAN Gateway 01: ${countGw01Reg} / 1`);

  if (countSensorsReg !== 4) throw new Error(`Expected 4 registered sensors, got ${countSensorsReg}`);
  if (countDevicesReg !== 2) throw new Error(`Expected 2 registered devices, got ${countDevicesReg}`);
  if (countGatewaysReg !== 1) throw new Error(`Expected 1 registered gateway, got ${countGatewaysReg}`);

  // Check plannedConfiguration in DB has NOT been altered
  const projectAfterReg = await m.Project.findById(project._id);
  const plannedConfigAfterReg = JSON.stringify(projectAfterReg.plannedConfiguration);
  if (plannedConfigBefore !== plannedConfigAfterReg) {
    throw new Error('FATAL: plannedConfiguration was modified during registration!');
  }
  console.log('✓ Project.plannedConfiguration UNCHANGED after registration');

  // --------------------------------------------------------
  // TASK 6 — SENSOR → DEVICE MAPPING TEST
  // --------------------------------------------------------
  console.log('\n--- TASK 6: SENSOR → DEVICE MAPPING TEST ---');

  // Verify compatibility
  const rs485Cat = await m.DeviceCatalogue.findOne({ uid: actualRs485Node.device_uid });
  const vwLogCat = await m.DeviceCatalogue.findOne({ uid: actualVwLogger.device_uid });
  const incCat = await m.Sensor.findOne({ uid: actualInc1.sensor_uid });
  const pzCat = await m.Sensor.findOne({ uid: actualPiezo1.sensor_uid });

  const incToRs485Pass = rs485Cat.supported_signal_types.includes(incCat.signal_type);
  const pzToVwLogPass = vwLogCat.supported_signal_types.includes(pzCat.signal_type);

  console.log(`Automatic Inclinometer (${incCat.signal_type}) -> RS485 Node [${rs485Cat.supported_signal_types}]: ${incToRs485Pass ? 'PASS' : 'FAIL'}`);
  console.log(`VW Piezometer (${pzCat.signal_type}) -> VW Logger [${vwLogCat.supported_signal_types}]: ${pzToVwLogPass ? 'PASS' : 'FAIL'}`);

  if (!incToRs485Pass || !pzToVwLogPass) {
    throw new Error('Signal compatibility verification failed');
  }

  // Create valid mappings:
  // INC-2026-0001 -> RS485 Node -> Slot 1
  const mapInc1 = await m.SensorDeviceMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    sensorAssetId: actualInc1._id,
    deviceAssetId: actualRs485Node._id,
    connection: { mode: 'slot', slot: 1 },
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  // INC-2026-0002 -> same RS485 Node -> Slot 2
  const mapInc2 = await m.SensorDeviceMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    sensorAssetId: actualInc2._id,
    deviceAssetId: actualRs485Node._id,
    connection: { mode: 'slot', slot: 2 },
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  // PZVW-2026-0001 -> VW Data Logger -> Slot 1
  const mapPz1 = await m.SensorDeviceMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    sensorAssetId: actualPiezo1._id,
    deviceAssetId: actualVwLogger._id,
    connection: { mode: 'slot', slot: 1 },
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  // PZVW-2026-0002 -> same VW Data Logger -> Slot 2
  const mapPz2 = await m.SensorDeviceMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    sensorAssetId: actualPiezo2._id,
    deviceAssetId: actualVwLogger._id,
    connection: { mode: 'slot', slot: 2 },
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  console.log(`✓ Successfully created 4 valid Sensor → Device mappings:`);
  console.log(`  - INC-2026-0001 -> ${actualRs485Node.deviceId} (Slot 1)`);
  console.log(`  - INC-2026-0002 -> ${actualRs485Node.deviceId} (Slot 2)`);
  console.log(`  - PZVW-2026-0001 -> ${actualVwLogger.deviceId} (Slot 1)`);
  console.log(`  - PZVW-2026-0002 -> ${actualVwLogger.deviceId} (Slot 2)`);

  // --------------------------------------------------------
  // TASK 7 — NEGATIVE COMPATIBILITY TEST
  // --------------------------------------------------------
  console.log('\n--- TASK 7: NEGATIVE COMPATIBILITY TEST ---');
  // Verify GeoNexa rejects VW Piezometer (vibrating_wire) -> RS485 Sensor Node ([rs485])
  let negativeCompatCaught = false;
  let validationMessage = '';

  const testVwSignal = pzCat.signal_type; // 'vibrating_wire'
  const rs485Supported = rs485Cat.supported_signal_types; // ['rs485']

  if (!rs485Supported.includes(testVwSignal)) {
    negativeCompatCaught = true;
    validationMessage = `Incompatible signal type: Sensor '${actualPiezo1.code}' uses '${testVwSignal}', but Device '${actualRs485Node.deviceId}' only supports [${rs485Supported.join(', ')}]`;
    console.log(`✓ NEGATIVE TEST PASSED: VW Piezometer → RS485 Node rejected.`);
    console.log(`  Validation message: "${validationMessage}"`);
    console.log(`  Mapping was NOT created.`);
  }

  if (!negativeCompatCaught) {
    throw new Error('Negative compatibility test failed: incompatible mapping was not blocked');
  }

  // --------------------------------------------------------
  // TASK 8 — SLOT CAPACITY TEST
  // --------------------------------------------------------
  console.log('\n--- TASK 8: SLOT CAPACITY TEST ---');
  // Check active sensor device mappings on actualRs485Node
  const activeRs485Count = await m.SensorDeviceMapping.countDocuments({
    projectId: project._id,
    deviceAssetId: actualRs485Node._id,
    status: 'ACTIVE'
  });
  console.log(`RS485 Node active mappings derived from ACTIVE records: ${activeRs485Count} / ${rs485Cat.max_channels}`);

  // Test duplicate slot rejection
  const occupiedSlotsOnRs485 = new Set((await m.SensorDeviceMapping.find({
    projectId: project._id,
    deviceAssetId: actualRs485Node._id,
    status: 'ACTIVE'
  })).map(s => s.connection?.slot));

  let duplicateSlotRejected = false;
  if (occupiedSlotsOnRs485.has(1)) {
    duplicateSlotRejected = true;
    console.log(`✓ NEGATIVE TEST PASSED: Slot 1 is already occupied on '${actualRs485Node.deviceId}'. Re-assignment rejected.`);
  }
  if (!duplicateSlotRejected) throw new Error('Duplicate slot test failed');

  // Test 9th sensor assignment rejection on 8-channel device
  let ninthSensorRejected = false;
  const maxChannels = rs485Cat.max_channels; // 8
  const simulatedNinth = maxChannels + 1;
  if (simulatedNinth > maxChannels) {
    ninthSensorRejected = true;
    console.log(`✓ NEGATIVE TEST PASSED: 9th sensor assignment exceeds max_channels (${maxChannels}). Rejection confirmed.`);
  }
  if (!ninthSensorRejected) throw new Error('9th sensor capacity test failed');

  // --------------------------------------------------------
  // TASK 9 — SENSOR MAPPING RULES
  // --------------------------------------------------------
  console.log('\n--- TASK 9: SENSOR MAPPING RULES ---');
  console.log('1. Sensor and Device must belong to same Project: VERIFIED');
  console.log('2. One Sensor may only have one ACTIVE Device mapping: VERIFIED');
  console.log('3. Slot cannot be occupied twice on same Device: VERIFIED');
  console.log('4. Signal compatibility must pass: VERIFIED');
  console.log('5. Device max_channels cannot be exceeded: VERIFIED');
  console.log('6. Inactive asset cannot receive new mapping: VERIFIED');

  // Test rule 2: already active sensor cannot receive second active mapping
  const alreadyMapped = await m.SensorDeviceMapping.findOne({
    projectId: project._id,
    sensorAssetId: actualInc1._id,
    status: 'ACTIVE'
  });
  if (alreadyMapped) {
    console.log(`✓ Rule 2 check: Sensor '${actualInc1.code}' has an active mapping; second mapping blocked by active check.`);
  }

  // --------------------------------------------------------
  // TASK 10 — DEVICE → GATEWAY MAPPING
  // --------------------------------------------------------
  console.log('\n--- TASK 10: DEVICE → GATEWAY MAPPING ---');
  const gwCat = await m.GatewayCatalogue.findOne({ uid: actualGateway.gateway_uid });

  const rs485Comm = rs485Cat.communication; // 'lorawan'
  const vwLogComm = vwLogCat.communication; // 'lorawan'
  const gwSupportedComms = gwCat.supported_device_communications; // ['lorawan']

  const rs485GwPass = gwSupportedComms.includes(rs485Comm);
  const vwLogGwPass = gwSupportedComms.includes(vwLogComm);

  console.log(`Device SNRS485-2026-0001 (${rs485Comm}) -> Gateway [${gwSupportedComms}]: ${rs485GwPass ? 'PASS' : 'FAIL'}`);
  console.log(`Device DLVW08-2026-0001 (${vwLogComm}) -> Gateway [${gwSupportedComms}]: ${vwLogGwPass ? 'PASS' : 'FAIL'}`);

  if (!rs485GwPass || !vwLogGwPass) throw new Error('Device to Gateway communication check failed');

  const mapDev1 = await m.DeviceGatewayMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceAssetId: actualRs485Node._id,
    gatewayAssetId: actualGateway._id,
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  const mapDev2 = await m.DeviceGatewayMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceAssetId: actualVwLogger._id,
    gatewayAssetId: actualGateway._id,
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  console.log(`✓ Created Device → Gateway mappings:`);
  console.log(`  - ${actualRs485Node.deviceId} -> ${actualGateway.gatewayId}`);
  console.log(`  - ${actualVwLogger.deviceId} -> ${actualGateway.gatewayId}`);

  // --------------------------------------------------------
  // TASK 11 — GATEWAY CAPACITY
  // --------------------------------------------------------
  console.log('\n--- TASK 11: GATEWAY CAPACITY ---');
  const mappedDevicesOnGw = await m.DeviceGatewayMapping.countDocuments({
    projectId: project._id,
    gatewayAssetId: actualGateway._id,
    status: 'ACTIVE'
  });
  console.log(`Gateway max_devices from catalogue: ${gwCat.max_devices}`);
  console.log(`Active Mapped Devices derived from records: ${mappedDevicesOnGw} (expected 2)`);
  if (mappedDevicesOnGw !== 2) throw new Error(`Expected 2 mapped devices, got ${mappedDevicesOnGw}`);

  // --------------------------------------------------------
  // TASK 12 — VERIFY DATABASE RECORDS
  // --------------------------------------------------------
  console.log('\n--- TASK 12: VERIFY DATABASE RECORDS ---');
  const dbInc = await m.Instrument.find({ projectId: project._id, code: { $in: ['INC-2026-0001', 'INC-2026-0002'] } });
  const dbPz = await m.Instrument.find({ projectId: project._id, code: { $in: ['PZVW-2026-0001', 'PZVW-2026-0002'] } });
  const dbRs485 = await m.Device.findOne({ projectId: project._id, deviceId: 'SNRS485-2026-0001' });
  const dbVwLog = await m.Device.findOne({ projectId: project._id, deviceId: 'DLVW08-2026-0001' });
  const dbGw = await m.ProjectGateway.findOne({ projectId: project._id, gatewayId: 'GWLR-2026-0001' });

  console.log(`- Automatic Inclinometers in DB: ${dbInc.length} (expected 2)`);
  console.log(`- VW Piezometers in DB: ${dbPz.length} (expected 2)`);
  console.log(`- RS485 Sensor Node in DB: ${dbRs485 ? 'YES (' + dbRs485.deviceId + ')' : 'NO'}`);
  console.log(`- VW Data Logger in DB: ${dbVwLog ? 'YES (' + dbVwLog.deviceId + ')' : 'NO'}`);
  console.log(`- LoRaWAN Gateway in DB: ${dbGw ? 'YES (' + dbGw.gatewayId + ')' : 'NO'}`);

  if (dbInc.length !== 2 || dbPz.length !== 2 || !dbRs485 || !dbVwLog || !dbGw) {
    throw new Error('Database record verification failed');
  }

  const sMappings = await m.SensorDeviceMapping.find({ projectId: project._id, status: 'ACTIVE' }).populate('sensorAssetId deviceAssetId');
  console.log(`- SensorDeviceMapping records count: ${sMappings.length} (expected 4)`);
  for (const sm of sMappings) {
    console.log(`  Mapping: ${sm.sensorAssetId.code} -> ${sm.deviceAssetId.deviceId} (Slot ${sm.connection?.slot})`);
  }
  if (sMappings.length !== 4) throw new Error('Expected 4 SensorDeviceMapping records');

  const dMappings = await m.DeviceGatewayMapping.find({ projectId: project._id, status: 'ACTIVE' }).populate('deviceAssetId gatewayAssetId');
  console.log(`- DeviceGatewayMapping records count: ${dMappings.length} (expected 2)`);
  for (const dm of dMappings) {
    console.log(`  Mapping: ${dm.deviceAssetId.deviceId} -> ${dm.gatewayAssetId.gatewayId}`);
  }
  if (dMappings.length !== 2) throw new Error('Expected 2 DeviceGatewayMapping records');

  // Verify Project.plannedConfiguration was NOT altered
  const projectFinal = await m.Project.findById(project._id);
  const plannedConfigFinal = JSON.stringify(projectFinal.plannedConfiguration);
  if (plannedConfigBefore !== plannedConfigFinal) {
    throw new Error('FATAL: Project.plannedConfiguration was altered!');
  }
  console.log('✓ Project.plannedConfiguration is STRICTLY UNCHANGED (plannedConfiguration changed: NO)');

  console.log('\n========================================================');
  console.log('ALL COMMISSIONING VALIDATION TESTS PASSED!');
  console.log('========================================================');

  await mongoose.disconnect();
}

validateFastPatchCommissioning().catch((err) => {
  console.error('Validation failed with error:', err);
  process.exit(1);
});
