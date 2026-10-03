import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const deviceSchema = new Schema({
  uid: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, required: true }, // referencing DeviceType code
  model: { type: String },
  supported_signal_types: [{ type: String }],
  max_channels: { type: Number, required: true, min: 1 },
  communication: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

export const DeviceCatalogue = model('DeviceCatalogue', deviceSchema);
