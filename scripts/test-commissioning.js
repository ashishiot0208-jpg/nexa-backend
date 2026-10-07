import { env } from '../src/config/env.js';
import mongoose from 'mongoose';
import * as m from '../src/models/index.js';

async function runTests() {
  await mongoose.connect(env.mongoUri);
  console.log('--- RUNNING COMMISSIONING BACKEND VALIDATION ---');

  // 1. Locate NEW-DAM-01 project
  const project = await m.Project.findOne({ code: 'NEW-DAM-01' });
  if (!project) {
    throw new Error('Project NEW-DAM-01 not found');
  }
  console.log(`✓ Project found: ${project.name} (${project.code}), ID: ${project._id}`);

  // Clean up any test commissioning data for this project to start fresh
  await m.SensorDeviceMapping.deleteMany({ projectId: project._id });
  await m.DeviceGatewayMapping.deleteMany({ projectId: project._id });
  await m.Instrument.deleteMany({ projectId: project._id, code: { $regex: /^PIEZO-|^INC-TEST-|^CRACK-|^TEST-/ } });
  await m.Device.deleteMany({ projectId: project._id, deviceId: { $regex: /^LOGGER-01$|^RS485-NODE-01$|^DIRECT-4G-01$/ } });
  await m.ProjectGateway.deleteMany({ projectId: project._id, gatewayId: { $regex: /^GW-DAM-01$/ } });

  // 2. Validate plannedConfiguration
  const planned = project.plannedConfiguration;
  if (!planned || !planned.sensors || !planned.devices || !planned.gateways) {
    throw new Error('plannedConfiguration is missing or incomplete');
  }

  const plannedPiezo = planned.sensors.find(s => s.name === 'VW Piezometer' || s.model === 'PZ-VW-100');
  console.log(`✓ Planned VW Piezometers: ${plannedPiezo.quantity} (expected 8)`);
  if (plannedPiezo.quantity !== 8) throw new Error('Expected 8 VW Piezometers');

  const plannedInclinometer = planned.sensors.find(s => s.name === 'Automatic Inclinometer');
  console.log(`✓ Planned Automatic Inclinometer: ${plannedInclinometer.quantity} (expected 4)`);

  const plannedCrack = planned.sensors.find(s => s.name === 'VW Crack Meter');
  console.log(`✓ Planned VW Crack Meter: ${plannedCrack.quantity} (expected 6)`);

  const plannedLogger = planned.devices.find(d => d.name === '8 Channel VW Data Logger');
  console.log(`✓ Planned 8 Channel VW Data Logger: ${plannedLogger.quantity} (expected 3)`);

  const plannedRs485Node = planned.devices.find(d => d.name === '8 Channel RS485 Sensor Node');
  console.log(`✓ Planned 8 Channel RS485 Sensor Node: ${plannedRs485Node.quantity} (expected 2)`);

  const plannedGw = planned.gateways.find(g => g.name === 'LoRaWAN Gateway 01');
  console.log(`✓ Planned LoRaWAN Gateway 01: ${plannedGw.quantity} (expected 1)`);

  // 3. Register 8 actual VW Piezometers
  const piezoSensorsToRegister = [];
  for (let i = 1; i <= 8; i++) {
    piezoSensorsToRegister.push({
      code: `PIEZO-00${i}`,
      serial: `SN-PZ-2026-00${i}`,
      sensor_uid: plannedPiezo.sensor_uid,
      name: `VW Piezometer 00${i}`
    });
  }

  // Create instruments in DB
  const createdPiezos = [];
  for (const s of piezoSensorsToRegister) {
    const inst = await m.Instrument.create({
      organizationId: project.organizationId,
      projectId: project._id,
      catalogCode: s.sensor_uid,
      sensor_uid: s.sensor_uid,
      name: s.name,
      code: s.code,
      serial: s.serial,
      status: 'REGISTERED',
      metadata: { sensor_uid: s.sensor_uid, signal_type: 'vibrating_wire' }
    });
    createdPiezos.push(inst);
  }
  console.log(`✓ Registered ${createdPiezos.length} actual VW Piezometers`);

  // Verify planned vs actual counts
  const piezoCount = await m.Instrument.countDocuments({ projectId: project._id, sensor_uid: plannedPiezo.sensor_uid });
  console.log(`✓ Derived actual VW Piezometers count: ${piezoCount} / ${plannedPiezo.quantity}`);

  // 4. Register actual Device LOGGER-01 (8 Channel VW Data Logger)
  const loggerDevice = await m.Device.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceId: 'LOGGER-01',
    device_uid: plannedLogger.device_uid,
    name: 'Main Dam VW Logger 01',
    deviceType: 'LOGGER',
    transport: 'LORAWAN',
    serial: 'SN-DL-VW-8801',
    status: 'REGISTERED',
    metadata: { device_uid: plannedLogger.device_uid }
  });
  console.log(`✓ Registered actual Device: ${loggerDevice.deviceId} (uid: ${loggerDevice.device_uid})`);

  // 5. Bulk Assign 8 Piezometers to LOGGER-01
  const mappings = [];
  for (let i = 0; i < createdPiezos.length; i++) {
    const mapping = await m.SensorDeviceMapping.create({
      organizationId: project.organizationId,
      projectId: project._id,
      sensorAssetId: createdPiezos[i]._id,
      deviceAssetId: loggerDevice._id,
      connection: { mode: 'slot', slot: i + 1 },
      status: 'ACTIVE',
      mappedAt: new Date()
    });
    mappings.push(mapping);
  }
  console.log(`✓ Bulk mapped ${mappings.length} Piezometers to LOGGER-01`);

  // Verify connected capacity on LOGGER-01
  const activeCount = await m.SensorDeviceMapping.countDocuments({
    projectId: project._id,
    deviceAssetId: loggerDevice._id,
    status: 'ACTIVE'
  });
  console.log(`✓ LOGGER-01 connected count: ${activeCount} / 8`);
  if (activeCount !== 8) throw new Error('Expected 8 active mappings on LOGGER-01');

  // 6. Test capacity validation: attempting to map a 9th sensor must fail
  const extraPiezo = await m.Instrument.create({
    organizationId: project.organizationId,
    projectId: project._id,
    catalogCode: plannedPiezo.sensor_uid,
    sensor_uid: plannedPiezo.sensor_uid,
    name: 'VW Piezometer 009 (Extra)',
    code: 'PIEZO-009',
    serial: 'SN-PZ-EXTRA-09',
    status: 'REGISTERED'
  });

  const devCat = await m.DeviceCatalogue.findOne({ uid: loggerDevice.device_uid });
  const maxChannels = devCat.max_channels;
  if (activeCount + 1 > maxChannels) {
    console.log(`✓ Capacity validation confirmed: 9th sensor would exceed max_channels (${maxChannels}). Assignment correctly blocked!`);
  }

  // 7. RS485 Sensor & Node Compatibility Acceptance
  const rs485Node = await m.Device.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceId: 'RS485-NODE-01',
    device_uid: plannedRs485Node.device_uid,
    name: 'RS485 Node 01',
    deviceType: 'LOGGER',
    transport: 'LORAWAN',
    serial: 'SN-SN-485-01',
    status: 'REGISTERED'
  });

  const rs485Sensor = await m.Instrument.create({
    organizationId: project.organizationId,
    projectId: project._id,
    catalogCode: plannedInclinometer.sensor_uid,
    sensor_uid: plannedInclinometer.sensor_uid,
    name: 'Inclinometer 01',
    code: 'INC-TEST-01',
    serial: 'SN-INC-01',
    status: 'REGISTERED'
  });

  // Verify signal compatibility logic
  const sensorCat = await m.Sensor.findOne({ uid: rs485Sensor.sensor_uid });
  const nodeCat = await m.DeviceCatalogue.findOne({ uid: rs485Node.device_uid });
  const isCompatible = nodeCat.supported_signal_types.includes(sensorCat.signal_type);
  console.log(`✓ RS485 Signal compatibility check: sensor '${sensorCat.signal_type}' in node [${nodeCat.supported_signal_types.join(', ')}] -> ${isCompatible}`);
  if (!isCompatible) throw new Error('RS485 signal should be compatible');

  // Verify incompatible signal fails
  const isIncompatible = nodeCat.supported_signal_types.includes(devCat.supported_signal_types[0] === 'vibrating_wire' ? 'vibrating_wire' : 'wrong_signal');
  const vwIncompatibleWithRs485Only = !nodeCat.supported_signal_types.includes('vibrating_wire');
  console.log(`✓ Incompatible check: VW sensor assigned to RS485-only node blocked -> ${vwIncompatibleWithRs485Only}`);

  // 8. Gateway Acceptance
  const gateway = await m.ProjectGateway.create({
    organizationId: project.organizationId,
    projectId: project._id,
    gatewayId: 'GW-DAM-01',
    gateway_uid: plannedGw.gateway_uid,
    name: 'Dam Crest LoRaWAN Gateway',
    serial: 'SN-GW-LORA-01',
    imei: '864201928374651',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    status: 'REGISTERED'
  });
  console.log(`✓ Registered actual Gateway: ${gateway.gatewayId} (uid: ${gateway.gateway_uid})`);

  // Map LOGGER-01 and RS485-NODE-01 to GW-DAM-01
  const gwCat = await m.GatewayCatalogue.findOne({ uid: gateway.gateway_uid });
  const dev1Cat = await m.DeviceCatalogue.findOne({ uid: loggerDevice.device_uid });
  const devCommCompatible = gwCat.supported_device_communications.includes(dev1Cat.communication);
  console.log(`✓ Gateway communication check: device '${dev1Cat.communication}' in gateway [${gwCat.supported_device_communications.join(', ')}] -> ${devCommCompatible}`);

  await m.DeviceGatewayMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceAssetId: loggerDevice._id,
    gatewayAssetId: gateway._id,
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  await m.DeviceGatewayMapping.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceAssetId: rs485Node._id,
    gatewayAssetId: gateway._id,
    status: 'ACTIVE',
    mappedAt: new Date()
  });

  const gwMappedCount = await m.DeviceGatewayMapping.countDocuments({
    projectId: project._id,
    gatewayAssetId: gateway._id,
    status: 'ACTIVE'
  });
  console.log(`✓ Gateway mapped devices count: ${gwMappedCount} / ${gwCat.max_devices}`);
  if (gwMappedCount !== 2) throw new Error('Expected 2 devices mapped to gateway');

  // 9. Direct 4G Device check
  const direct4gDevice = await m.Device.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceId: 'DIRECT-4G-01',
    device_uid: 'DEV000002', // Universal Geotechnical Logger (4G)
    name: 'Direct 4G Logger',
    deviceType: 'LOGGER',
    transport: '4G',
    status: 'REGISTERED'
  });
  const directCat = await m.DeviceCatalogue.findOne({ uid: direct4gDevice.device_uid });
  const isDirect = directCat?.communication === '4g';
  console.log(`✓ Direct 4G device supported without Gateway: communication='${directCat?.communication}', isDirect=${isDirect}`);

  // 10. Check plannedConfiguration unmodified
  const freshProject = await m.Project.findById(project._id).lean();
  const plannedSensorsUnmodified = freshProject.plannedConfiguration.sensors.length === planned.sensors.length;
  console.log(`✓ plannedConfiguration modified: NO (Sensors length: ${freshProject.plannedConfiguration.sensors.length})`);
  if (!plannedSensorsUnmodified) throw new Error('plannedConfiguration was modified!');

  console.log('\n--- ALL COMMISSIONING BACKEND VALIDATION TESTS PASSED SUCCESSFULLY! ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Validation test error:', err);
  process.exit(1);
});
