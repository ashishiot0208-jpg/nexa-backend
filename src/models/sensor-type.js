import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const sensorTypeSchema = new Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

export const SensorType = model('SensorType', sensorTypeSchema);
