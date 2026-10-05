import mongoose from 'mongoose';
const { Schema, model } = mongoose;

import { Counter } from './sensor.js'; // Reusing Counter model

const sensorItemSchema = new Schema({
  sensor_uid: { type: String, required: true },
  default_quantity: { type: Number, required: true, min: 1 }
}, { _id: false });

const deviceItemSchema = new Schema({
  device_uid: { type: String, required: true },
  default_quantity: { type: Number, required: true, min: 1 }
}, { _id: false });

const gatewayItemSchema = new Schema({
  gateway_uid: { type: String, required: true },
  default_quantity: { type: Number, required: true, min: 1 }
}, { _id: false });

const projectTemplateSchema = new Schema({
  uid: { type: String, unique: true },
  name: { type: String, required: true },
  type: { type: String, required: true },
  description: { type: String, default: '' },
  sensors: [sensorItemSchema],
  devices: [deviceItemSchema],
  gateways: [gatewayItemSchema],
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

projectTemplateSchema.pre('save', function (next) {
  const doc = this;
  if (doc.isNew && !doc.uid) {
    Counter.findByIdAndUpdate(
      { _id: 'projectTemplateUid' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).then(counter => {
      doc.uid = 'TPL' + String(counter.seq).padStart(6, '0');
      next();
    }).catch(error => next(error));
  } else {
    next();
  }
});

// Enforce at least one item overall
projectTemplateSchema.pre('validate', function(next) {
  const totalItems = (this.sensors?.length || 0) + (this.devices?.length || 0) + (this.gateways?.length || 0);
  if (totalItems === 0) {
    this.invalidate('sensors', 'Template must contain at least one catalogue item (Sensor, Device, or Gateway).');
  }
  next();
});

export const ProjectTemplate = model('ProjectTemplate', projectTemplateSchema);
