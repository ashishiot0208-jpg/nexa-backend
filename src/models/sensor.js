import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});
export const Counter = mongoose.models.Counter || model('Counter', counterSchema);

const channelSchema = new Schema({
  measurement: { type: String, required: true },
  unit: { type: String, required: true },
  range: String,
  resolution: String,
  accuracy: String
}, { _id: false });

const sensorSchema = new Schema({
  uid: { type: String, unique: true },
  name: { type: String, required: true },
  type: { type: String, required: true },
  model: String,
  signal_type: { type: String, required: true },
  channels: {
    type: [channelSchema],
    required: true,
    validate: [v => v && v.length > 0, 'At least one channel is required']
  },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

sensorSchema.pre('save', function (next) {
  const doc = this;
  if (doc.isNew && !doc.uid) {
    Counter.findByIdAndUpdate(
      { _id: 'sensorUid' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).then(counter => {
      doc.uid = 'SNS' + String(counter.seq).padStart(6, '0');
      next();
    }).catch(error => next(error));
  } else {
    next();
  }
});

export const Sensor = model('Sensor', sensorSchema);
