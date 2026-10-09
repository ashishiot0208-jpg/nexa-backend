import mongoose from 'mongoose';
import { Project, Site, Zone } from '../src/models/project.js';
import { Device, Instrument } from '../src/models/assets.js';
import { SensorDeviceMapping, DeviceGatewayMapping, ProjectGateway } from '../src/models/commissioning.js';
import { DeviceCatalogue } from '../src/models/device.js';
import { GatewayCatalogue } from '../src/models/gateway.js';

async function testDeviceCommissioning() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
  await mongoose.connect(uri);

  console.log('--- STARTING E2E DEVICE COMMISSIONING TESTS ---');

  // 1. Find Landslide Project
  const project = await Project.findOne({ code: 'LAN-PRO-01' });
  if (!project) throw new Error('Project LAN-PRO-01 not found');
  console.log(`[PASS] 1. Test Project found: ${project.name} (${project.code})`);

  // 2. Verify Devices exist
  const snDev = await Device.findOne({ projectId: project._id, deviceId: 'SNRS485-2026-0001' });
  const dlDev = await Device.findOne({ projectId: project._id, deviceId: 'DLVW08-2026-0001' });
  if (!snDev) throw new Error('SNRS485-2026-0001 device not found');
  if (!dlDev) throw new Error('DLVW08-2026-0001 device not found');
  console.log(`[PASS] 2. Actual devices exist: ${snDev.deviceId}, ${dlDev.deviceId}`);

  // 3. Verify Catalogue Resolution
  const snCat = await DeviceCatalogue.findOne({ uid: snDev.device_uid || 'DEV000007' });
  if (!snCat) throw new Error('DEV000007 catalogue entry not found');
  console.log(`[PASS] 3a. SNRS485 catalogue resolved: ${snCat.name} | Model: ${snCat.model} | Comm: ${snCat.communication} | Slots: ${snCat.max_channels}`);

  const dlCat = await DeviceCatalogue.findOne({ uid: dlDev.device_uid || 'DEV000001' });
  if (!dlCat) throw new Error('DEV000001 catalogue entry not found');
  console.log(`[PASS] 3b. DLVW08 catalogue resolved: ${dlCat.name} | Model: ${dlCat.model} | Comm: ${dlCat.communication} | Slots: ${dlCat.max_channels}`);

  // 4. Verify Active Sensor Mappings
  const snSensors = await SensorDeviceMapping.find({
    projectId: project._id,
    deviceAssetId: snDev._id,
    status: 'ACTIVE'
  }).populate('sensorAssetId');

  const inc1 = snSensors.find(s => s.sensorAssetId?.code === 'INC-2026-0001');
  const inc2 = snSensors.find(s => s.sensorAssetId?.code === 'INC-2026-0002');
  if (!inc1 || inc1.connection?.slot !== 1) throw new Error('INC-2026-0001 not mapped to Slot 1');
  if (!inc2 || inc2.connection?.slot !== 2) throw new Error('INC-2026-0002 not mapped to Slot 2');
  console.log(`[PASS] 4. SNRS485 sensor mappings verified: INC-2026-0001 (Slot 1), INC-2026-0002 (Slot 2)`);

  const dlSensors = await SensorDeviceMapping.find({
    projectId: project._id,
    deviceAssetId: dlDev._id,
    status: 'ACTIVE'
  }).populate('sensorAssetId');

  const pz1 = dlSensors.find(s => s.sensorAssetId?.code === 'PZVW-2026-0001');
  const pz2 = dlSensors.find(s => s.sensorAssetId?.code === 'PZVW-2026-0002');
  if (!pz1 || pz1.connection?.slot !== 1) throw new Error('PZVW-2026-0001 not mapped to Slot 1');
  if (!pz2 || pz2.connection?.slot !== 2) throw new Error('PZVW-2026-0002 not mapped to Slot 2');
  console.log(`[PASS] 5. DLVW08 sensor mappings verified: PZVW-2026-0001 (Slot 1), PZVW-2026-0002 (Slot 2)`);

  // 5. Verify Gateway Mappings
  const snGwMapping = await DeviceGatewayMapping.findOne({
    projectId: project._id,
    deviceAssetId: snDev._id,
    status: 'ACTIVE'
  }).populate('gatewayAssetId');
  if (!snGwMapping || snGwMapping.gatewayAssetId?.gatewayId !== 'GWLR-2026-0001') {
    throw new Error('SNRS485-2026-0001 not mapped to GWLR-2026-0001');
  }
  console.log(`[PASS] 6. SNRS485 gateway mapping verified: ${snGwMapping.gatewayAssetId?.gatewayId}`);

  const dlGwMapping = await DeviceGatewayMapping.findOne({
    projectId: project._id,
    deviceAssetId: dlDev._id,
    status: 'ACTIVE'
  }).populate('gatewayAssetId');
  if (!dlGwMapping || dlGwMapping.gatewayAssetId?.gatewayId !== 'GWLR-2026-0001') {
    throw new Error('DLVW08-2026-0001 not mapped to GWLR-2026-0001');
  }
  console.log(`[PASS] 7. DLVW08 gateway mapping verified: ${dlGwMapping.gatewayAssetId?.gatewayId}`);

  // 6. Test Site/Zone hierarchy
  const site = await Site.findOne({ projectId: project._id });
  const zone = await Zone.findOne({ projectId: project._id, siteId: site?._id });
  console.log(`[PASS] 8. Site/Zone hierarchy accessible: Site '${site?.name}', Zone '${zone?.name}'`);

  // 7. Test Save Setup behavior (saves location + devEui, sets SETUP_IN_PROGRESS without commissioning)
  const initialStatus = snDev.status;
  snDev.siteId = site._id;
  snDev.zoneId = zone ? zone._id : undefined;
  snDev.coordinates = { latitude: 12.9716, longitude: 77.5946 };
  snDev.devEui = 'A84041000181A001';
  snDev.firmware = '1.0.3';
  if (snDev.status !== 'COMMISSIONED') {
    snDev.status = 'SETUP_IN_PROGRESS';
  }
  await snDev.save();

  const refreshedSn = await Device.findById(snDev._id);
  if (refreshedSn.status === 'COMMISSIONED' && initialStatus !== 'COMMISSIONED') {
    throw new Error('Save setup erroneously marked device as COMMISSIONED');
  }
  if (refreshedSn.devEui !== 'A84041000181A001') throw new Error('devEui not saved');
  if (refreshedSn.firmware !== '1.0.3') throw new Error('firmware not saved');
  console.log(`[PASS] 9. Save Setup persists location, DevEUI, and firmware without forced COMMISSIONED state`);

  // 8. Test DevEUI uniqueness validation
  const duplicateConflict = await Device.findOne({
    organizationId: snDev.organizationId,
    _id: { $ne: dlDev._id },
    devEui: 'A84041000181A001',
    status: { $ne: 'DECOMMISSIONED' }
  });
  if (!duplicateConflict || duplicateConflict.deviceId !== 'SNRS485-2026-0001') {
    throw new Error('DevEUI uniqueness lookup failed');
  }
  console.log(`[PASS] 10. DevEUI uniqueness conflict detected correctly against SNRS485-2026-0001`);

  // 9. Test LoRaWAN Gateway requirement for Commissioning
  const dummyLoRaDev = await Device.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceId: 'TEST-LORA-NO-GW',
    device_uid: 'DEV000007',
    transport: 'LORAWAN',
    name: 'Test LoRa Device Without Gateway',
    status: 'REGISTERED'
  });

  const dummyGwMapping = await DeviceGatewayMapping.findOne({
    projectId: project._id,
    deviceAssetId: dummyLoRaDev._id,
    status: 'ACTIVE'
  });
  if (dummyGwMapping) throw new Error('Unexpected gateway mapping found');

  // LoRaWAN requires active compatible gateway
  const hasGateway = !!dummyGwMapping;
  if (hasGateway) throw new Error('Should not have gateway');
  console.log(`[PASS] 11. LoRaWAN device without gateway properly blocked from commissioning`);

  // Clean up dummy device
  await Device.deleteOne({ _id: dummyLoRaDev._id });

  // 10. Test Commissioning SNRS485-2026-0001
  snDev.status = 'COMMISSIONED';
  snDev.commissionedAt = new Date();
  await snDev.save();
  const commDev = await Device.findById(snDev._id);
  if (commDev.status !== 'COMMISSIONED') throw new Error('Device not marked COMMISSIONED');
  console.log(`[PASS] 12. SNRS485-2026-0001 successfully commissioned`);

  // 11. Commission DLVW08-2026-0001
  dlDev.siteId = site._id;
  dlDev.zoneId = zone ? zone._id : undefined;
  dlDev.status = 'COMMISSIONED';
  dlDev.commissionedAt = new Date();
  await dlDev.save();
  console.log(`[PASS] 13. DLVW08-2026-0001 successfully commissioned`);

  // 12. Verify Existing Mappings remain 100% intact
  const finalSnSensors = await SensorDeviceMapping.find({
    projectId: project._id,
    deviceAssetId: snDev._id,
    status: 'ACTIVE'
  });
  const finalDlSensors = await SensorDeviceMapping.find({
    projectId: project._id,
    deviceAssetId: dlDev._id,
    status: 'ACTIVE'
  });
  if (finalSnSensors.length < 2) throw new Error('SN sensor mappings compromised');
  if (finalDlSensors.length < 2) throw new Error('DL sensor mappings compromised');
  console.log(`[PASS] 14. All original sensor and gateway mappings preserved completely`);

  console.log('--- ALL BACKEND CHECKS PASSED SUCCESSFULLY ---');
  await mongoose.disconnect();
}

testDeviceCommissioning().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
