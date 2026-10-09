import mongoose from 'mongoose';
import { Project, Site, Zone } from '../src/models/project.js';
import { Device, Instrument } from '../src/models/assets.js';
import { SensorDeviceMapping, DeviceGatewayMapping } from '../src/models/commissioning.js';
import { DeviceCatalogue } from '../src/models/device.js';

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
  console.log('Connecting to', uri);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    console.log('Connected to MongoDB successfully');
  } catch (err) {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  }

  // Find Landslide project
  const project = await Project.findOne({ code: 'LAN-PRO-01' });
  if (!project) {
    console.log('Project LAN-PRO-01 not found! Listing all projects:');
    const projects = await Project.find({});
    console.log(projects.map(p => ({ id: p._id, name: p.name, code: p.code })));
    process.exit(1);
  }
  console.log(`Found Project: ${project.name} (${project.code}), ID: ${project._id}`);

  // Check Devices
  const devices = await Device.find({ projectId: project._id });
  console.log(`Devices in project (${devices.length}):`);
  for (const d of devices) {
    console.log(`- Device ID: ${d.deviceId}, Model: ${d.model}, Comm: ${d.communication || d.transport}, Status: ${d.status}`);
  }

  // Check Sensor mappings
  const sensorMappings = await SensorDeviceMapping.find({ projectId: project._id, status: 'ACTIVE' })
    .populate('sensorAssetId')
    .populate('deviceAssetId');
  console.log(`Active SensorDeviceMappings (${sensorMappings.length}):`);
  for (const sm of sensorMappings) {
    console.log(`- Instrument: ${sm.sensorAssetId?.code} -> Device: ${sm.deviceAssetId?.deviceId} (Slot ${sm.connection?.slot})`);
  }

  // Check Gateway mappings
  const gwMappings = await DeviceGatewayMapping.find({ projectId: project._id, status: 'ACTIVE' })
    .populate('deviceAssetId')
    .populate('gatewayAssetId');
  console.log(`Active DeviceGatewayMappings (${gwMappings.length}):`);
  for (const gm of gwMappings) {
    console.log(`- Device: ${gm.deviceAssetId?.deviceId} -> Gateway: ${gm.gatewayAssetId?.gatewayId}`);
  }

  // Test setup resolution for SNRS485-2026-0001
  const snDev = await Device.findOne({ projectId: project._id, deviceId: 'SNRS485-2026-0001' });
  if (snDev) {
    console.log('\n--- Verifying SNRS485-2026-0001 Setup Resolution ---');
    console.log('snDev doc:', { deviceId: snDev.deviceId, model: snDev.model, device_uid: snDev.device_uid, transport: snDev.transport });
    let catalog = null;
    if (snDev.device_uid) {
      catalog = await DeviceCatalogue.findOne({ uid: snDev.device_uid });
    }
    if (!catalog && snDev.model) {
      catalog = await DeviceCatalogue.findOne({ model: snDev.model });
    }
    console.log('Catalogue resolved:', catalog?.name, catalog?.model, 'max_channels:', catalog?.max_channels, 'comm:', catalog?.communication);

    const devSensors = await SensorDeviceMapping.find({ deviceAssetId: snDev._id, status: 'ACTIVE' }).populate('sensorAssetId');
    console.log('Connected sensors count:', devSensors.length);
    devSensors.forEach(s => console.log(`  * ${s.sensorAssetId?.code} -> Slot ${s.connection?.slot}`));

    const devGw = await DeviceGatewayMapping.findOne({ deviceAssetId: snDev._id, status: 'ACTIVE' }).populate('gatewayAssetId');
    console.log('Connected Gateway:', devGw?.gatewayAssetId?.gatewayId);
  }

  // Test setup resolution for DLVW08-2026-0001
  const dlDev = await Device.findOne({ projectId: project._id, deviceId: 'DLVW08-2026-0001' });
  if (dlDev) {
    console.log('\n--- Verifying DLVW08-2026-0001 Setup Resolution ---');
    console.log('dlDev doc:', { deviceId: dlDev.deviceId, model: dlDev.model, device_uid: dlDev.device_uid, transport: dlDev.transport });
    let catalog = null;
    if (dlDev.device_uid) {
      catalog = await DeviceCatalogue.findOne({ uid: dlDev.device_uid });
    }
    if (!catalog && dlDev.model) {
      catalog = await DeviceCatalogue.findOne({ model: dlDev.model });
    }
    console.log('Catalogue resolved:', catalog?.name, catalog?.model, 'max_channels:', catalog?.max_channels, 'comm:', catalog?.communication);

    const devSensors = await SensorDeviceMapping.find({ deviceAssetId: dlDev._id, status: 'ACTIVE' }).populate('sensorAssetId');
    console.log('Connected sensors count:', devSensors.length);
    devSensors.forEach(s => console.log(`  * ${s.sensorAssetId?.code} -> Slot ${s.connection?.slot}`));

    const devGw = await DeviceGatewayMapping.findOne({ deviceAssetId: dlDev._id, status: 'ACTIVE' }).populate('gatewayAssetId');
    console.log('Connected Gateway:', devGw?.gatewayAssetId?.gatewayId);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
