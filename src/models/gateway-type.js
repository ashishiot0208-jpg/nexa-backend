import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const gatewayTypeSchema = new Schema({
  code: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

export const GatewayType = model('GatewayType', gatewayTypeSchema);
