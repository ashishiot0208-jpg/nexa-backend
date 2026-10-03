import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const deviceTypeSchema = new Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

export const DeviceType = model('DeviceType', deviceTypeSchema);
