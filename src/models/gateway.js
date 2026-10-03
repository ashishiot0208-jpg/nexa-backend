import mongoose from 'mongoose';
const { Schema, model } = mongoose;
import { Counter } from './sensor.js';

const gatewaySchema = new Schema({
  uid: { type: String, unique: true },
  name: { type: String, required: true },
  type: { type: String, required: true },
  model: { type: String },
  supported_device_communications: {
    type: [String],
    required: true,
    validate: [v => v && v.length > 0, 'At least one supported device communication is required']
  },
  backhaul: {
    type: [String],
    required: true,
    validate: [v => v && v.length > 0, 'At least one backhaul method is required']
  },
  max_devices: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

gatewaySchema.pre('save', function (next) {
  const doc = this;
  if (doc.isNew && !doc.uid) {
    Counter.findByIdAndUpdate(
      { _id: 'gatewayUid' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).then(counter => {
      doc.uid = 'GW' + String(counter.seq).padStart(6, '0');
      next();
    }).catch(error => next(error));
  } else {
    next();
  }
});

export const GatewayCatalogue = model('GatewayCatalogue', gatewaySchema);
