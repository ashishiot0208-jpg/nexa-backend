import mongoose from 'mongoose';
import 'dotenv/config';
import { ProjectTemplate, Sensor, Device, GatewayCatalogue as Gateway } from '../src/models/index.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  // Let's get active sensors/devices to map to our test.
  // The user said: "Create this manually for testing... VW Piezometer ... Automatic Inclinometer ... VW Crack Meter"
  const piezometer = await Sensor.findOne({ name: /Piezometer/i, status: 'active' });
  const inclinometer = await Sensor.findOne({ name: /Inclinometer/i, status: 'active' });
  const crackMeter = await Sensor.findOne({ name: /Crack Meter/i, status: 'active' });
  
  const vwLogger = await Device.findOne({ name: /Data Logger/i, status: 'active' });
  const uniLogger = await Device.findOne({ name: /Universal/i, status: 'active' });
  
  const loraGateway = await Gateway.findOne({ name: /LoRaWAN/i, status: 'active' });

  if (!piezometer || !inclinometer || !crackMeter || !vwLogger || !uniLogger || !loraGateway) {
    console.log('Missing some required active hardware from catalogue, creating a basic template with whatever is available...');
  }

  const sUid1 = piezometer?.uid || 'SNS000001';
  const sUid2 = inclinometer?.uid || 'SNS000002';
  const sUid3 = crackMeter?.uid || 'SNS000003';
  
  const dUid1 = vwLogger?.uid || 'DEV000001';
  const dUid2 = uniLogger?.uid || 'DEV000002';
  
  const gUid1 = loraGateway?.uid || 'GW000001';

  await ProjectTemplate.create({
    name: 'Dam Monitoring',
    type: 'dam_monitoring',
    description: 'Recommended starting configuration for dam geotechnical monitoring.',
    sensors: [
      { sensor_uid: sUid1, default_quantity: 4 },
      { sensor_uid: sUid2, default_quantity: 2 },
      { sensor_uid: sUid3, default_quantity: 4 }
    ],
    devices: [
      { device_uid: dUid1, default_quantity: 2 },
      { device_uid: dUid2, default_quantity: 1 }
    ],
    gateways: [
      { gateway_uid: gUid1, default_quantity: 1 }
    ]
  });

  console.log('Test template created successfully.');
  process.exit(0);
}

run().catch(console.error);
