import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const rawReadingSchema = new Schema({
  ingestionId: { type: String, required: true, unique: true },
  sourceEventId: { type: String, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },
  channelId: { type: Schema.Types.ObjectId, ref: 'SensorChannel', index: true },
  channelCode: String,
  sampleTime: { type: Date, required: true, index: true },
  serverReceivedAt: { type: Date, default: Date.now, index: true },
  messageId: String,
  sequenceNumber: Number,
  rawValue: Schema.Types.Mixed,
  rawUnit: String,
  quality: { type: String, enum: ['PENDING', 'VALID', 'SUSPECT', 'INVALID', 'MISSING', 'MANUALLY_VERIFIED', 'MANUALLY_REJECTED'], default: 'PENDING' },
  qualityReasons: { type: [String], default: [] },
  parserVersion: { type: String, default: '1.0' },
  sourceMetadata: { type: Schema.Types.Mixed, default: {} },
  originalPacket: { type: Schema.Types.Mixed, required: true }
}, { timestamps: true });
rawReadingSchema.index({ projectId: 1, instrumentId: 1, channelId: 1, sampleTime: -1 });
rawReadingSchema.index({ projectId: 1, channelId: 1, sampleTime: -1 });
rawReadingSchema.index({ deviceId: 1, messageId: 1, channelCode: 1 }, { unique: true, sparse: true });

const derivedReadingSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
  channelId: { type: Schema.Types.ObjectId, ref: 'SensorChannel' },
  rawReadingId: { type: Schema.Types.ObjectId, ref: 'RawReading' },
  parameterCode: { type: String, required: true, index: true },
  observedAt: { type: Date, required: true, index: true },
  value: { type: Number, required: true },
  unit: String,
  deltaFromBaseline: Number,
  ratePerHour: Number,
  accelerationPerHour2: Number,
  quality: { type: String, enum: ['VALID', 'SUSPECT', 'INVALID', 'MISSING', 'MANUALLY_VERIFIED', 'MANUALLY_REJECTED'], default: 'VALID' },
  qualityReasons: { type: [String], default: [] },
  calibrationVersion: Number,
  baselineVersion: Number,
  formulaVersion: { type: String, default: '1.0' },
  revision: { type: Number, default: 1 },
  sourceReadingIds: [{ type: Schema.Types.ObjectId, ref: 'RawReading' }],
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
derivedReadingSchema.index({ projectId: 1, instrumentId: 1, parameterCode: 1, observedAt: -1 });

const deviceTelemetrySchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  observedAt: { type: Date, required: true, index: true },
  batteryV: Number,
  rssiDbm: Number,
  network: String,
  internalTempC: Number,
  resetCount: Number,
  memoryFree: Number,
  faultBits: [String],
  healthGrade: { type: String, enum: ['H0', 'H1', 'H2', 'H3', 'H4'], default: 'H0' },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
deviceTelemetrySchema.index({ projectId: 1, deviceId: 1, observedAt: -1 });

const latestStateSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true },
  parameterCode: { type: String, required: true },
  observedAt: { type: Date, required: true },
  value: Number,
  unit: String,
  quality: String,
  ratePerHour: Number,
  severity: { type: String, default: 'S0' },
  decisionId: { type: Schema.Types.ObjectId, ref: 'DecisionSnapshot' }
}, { timestamps: true });
latestStateSchema.index({ instrumentId: 1, parameterCode: 1 }, { unique: true });
latestStateSchema.index({ projectId: 1, instrumentId: 1 });

export const RawReading = model('RawReading', rawReadingSchema);
export const DerivedReading = model('DerivedReading', derivedReadingSchema);
export const DeviceTelemetry = model('DeviceTelemetry', deviceTelemetrySchema);
export const LatestState = model('LatestState', latestStateSchema);
