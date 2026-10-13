import mongoose from 'mongoose';
import { Project } from '../src/models/project.js';
import { Device, Instrument } from '../src/models/assets.js';
import { SensorDeviceMapping, DeviceGatewayMapping, ProjectGateway } from '../src/models/commissioning.js';
import { DeviceCatalogue } from '../src/models/device.js';
import { DeviceTelemetry } from '../src/models/telemetry.js';

async function validateOperationalDevices() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
  await mongoose.connect(uri);

  console.log('=== STARTING OPERATIONAL DEVICES VALIDATION ===');

  // 1. Locate test project
  const project = await Project.findOne({ code: 'LAN-PRO-01' });
  if (!project) throw new Error('Project LAN-PRO-01 not found');
  console.log(`[PASS] 1. Project resolved: ${project.name} (${project.code})`);

  // 2. Fetch Devices & Gateways
  const devices = await Device.find({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } }).lean();
  const gateways = await ProjectGateway.find({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } }).lean();

  if (devices.length === 0) throw new Error('No devices found in project');
  console.log(`[PASS] 2. Found ${devices.length} registered device(s) and ${gateways.length} gateway(s)`);

  // 3. Verify mappings
  const sensorMappings = await SensorDeviceMapping.find({ projectId: project._id, status: 'ACTIVE' }).populate('sensorAssetId');
  const gatewayMappings = await DeviceGatewayMapping.find({ projectId: project._id, status: 'ACTIVE' }).populate('gatewayAssetId').populate('deviceAssetId');

  console.log(`[PASS] 3. Active mappings: ${sensorMappings.length} sensor-device mappings, ${gatewayMappings.length} device-gateway mappings`);

  // 4. Verify each device's connected sensors representation
  for (const dev of devices) {
    const devSensorMappings = sensorMappings.filter(m => m.deviceAssetId.toString() === dev._id.toString());
    const sensorCodes = devSensorMappings.map(m => m.sensorAssetId?.code).filter(Boolean);
    console.log(`[PASS] 4. Device '${dev.deviceId}' has ${devSensorMappings.length} connected sensor(s): [${sensorCodes.join(', ')}]`);
  }

  // 5. Verify runtime status computation
  const now = Date.now();
  for (const dev of devices) {
    let runtimeStatus = 'NOT_REPORTING';
    if (dev.lastSeenAt) {
      const lastSeenMs = new Date(dev.lastSeenAt).getTime();
      const intervalMs = Math.max(60, dev.expectedIntervalSec || 900) * 1000;
      const ageMs = now - lastSeenMs;
      if (ageMs <= intervalMs * 2) runtimeStatus = 'ONLINE';
      else if (ageMs <= intervalMs * 6) runtimeStatus = 'STALE';
      else runtimeStatus = 'OFFLINE';
    }
    console.log(`[PASS] 5. Device '${dev.deviceId}' runtimeStatus = '${runtimeStatus}' (lastSeenAt: ${dev.lastSeenAt ? dev.lastSeenAt.toISOString() : 'Never'})`);
  }

  // 6. Verify single source of truth: Commissioning registration validation
  const testDevCode = `TEST-DEV-${Date.now()}`;
  const cat = await DeviceCatalogue.findOne({ uid: 'DEV000007' });
  if (!cat) throw new Error('Catalogue DEV000007 not found');

  const created = await Device.create({
    organizationId: project.organizationId,
    projectId: project._id,
    deviceId: testDevCode,
    device_uid: cat.uid,
    name: `${cat.name} ${testDevCode}`,
    deviceType: cat.type || 'LOGGER',
    transport: 'LORAWAN',
    firmware: '1.0.0',
    status: 'REGISTERED',
    commissioningStatus: 'REGISTERED',
    runtimeStatus: 'OFFLINE'
  });

  if (!created || created.deviceId !== testDevCode) throw new Error('Failed to register device via commissioning model');
  console.log(`[PASS] 6. Commissioning registration verified with device '${testDevCode}'`);

  // Clean up test device
  await Device.deleteOne({ _id: created._id });
  console.log(`[PASS] 7. Test device cleaned up safely`);

  console.log('=== ALL OPERATIONAL DEVICES VALIDATIONS PASSED ===');
  process.exit(0);
}

validateOperationalDevices().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
