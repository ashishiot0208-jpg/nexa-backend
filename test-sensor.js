import mongoose from 'mongoose';
import { env } from './src/config/env.js';
import { Sensor, Counter } from './src/models/index.js';

async function test() {
  await mongoose.connect(env.mongoUri);
  await Sensor.deleteMany({});
  await Counter.deleteMany({});

  const sensor = await Sensor.create({
    name: 'VW Crack Meter',
    type: 'crack_meter',
    model: '1201V-CM-LI',
    signal_type: 'vibrating_wire',
    channels: [
      {
        measurement: 'crack_displacement',
        unit: 'mm',
        range: 'Up to 150 mm',
        resolution: '0.02% FSR',
        accuracy: '±0.2% FSR'
      }
    ],
    status: 'active'
  });

  console.log('Created Sensor UID:', sensor.uid);
  process.exit(0);
}

test().catch(e => {
  console.error(e);
  process.exit(1);
});
