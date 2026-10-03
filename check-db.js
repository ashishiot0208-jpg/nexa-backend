import mongoose from 'mongoose';
import { Sensor } from './src/models/sensor.js';

async function check() {
  await mongoose.connect('mongodb://127.0.0.1:27017/nexaiq', { serverSelectionTimeoutMS: 2000 });
  const sensors = await Sensor.find({}).lean();
  console.log("ALL SENSORS:");
  console.log(JSON.stringify(sensors, null, 2));
  mongoose.disconnect();
}
check().catch(console.error);
