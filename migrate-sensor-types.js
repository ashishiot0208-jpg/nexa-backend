import mongoose from 'mongoose';
import { env } from './src/config/env.js';
import { Sensor, SensorType } from './src/models/index.js';

async function migrate() {
  await mongoose.connect(env.mongoUri);
  const sensors = await Sensor.find().lean();
  
  const uniqueTypes = new Set(sensors.map(s => s.type));
  console.log('Found existing types:', Array.from(uniqueTypes));

  const migrated = [];
  for (const type of uniqueTypes) {
    if (!type) continue;
    
    // Default name fallback based on code logic reversed (just capitalize)
    const name = type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    const existing = await SensorType.findOne({ code: type });
    if (!existing) {
      await SensorType.create({
        code: type,
        name: name,
        status: 'active'
      });
      migrated.push(type);
    }
  }

  console.log('Migrated new types:', migrated);
  process.exit(0);
}

migrate().catch(e => {
  console.error(e);
  process.exit(1);
});
