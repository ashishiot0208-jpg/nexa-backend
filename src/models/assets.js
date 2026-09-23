import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const instrumentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
  zoneId: { type: Schema.Types.ObjectId, ref: 'Zone' },
  catalogCode: { type: String, required: true, uppercase: true },
  name: { type: String, required: true },
  code: { type: String, required: true },
  serial: String,
  installDate: Date,
  coordinates: Schema.Types.Mixed,
  orientationDeg: Number,
  depthM: Number,
  status: { type: String, enum: ['PLANNED', 'COMMISSIONING', 'COMMISSIONED', 'MAINTENANCE', 'DECOMMISSIONED'], default: 'PLANNED' },
  commissionedAt: Date,
  commissionedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
instrumentSchema.index({ projectId: 1, code: 1 }, { unique: true });

const sensorChannelSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device' },
  code: { type: String, required: true },
  sourceField: String,
  parameterCode: { type: String, required: true },
  rawUnit: String,
  engineeringUnit: String,
  sampleIntervalSec: { type: Number, default: 900 },
  calibration: { scale: { type: Number, default: 1 }, offset: { type: Number, default: 0 }, version: { type: Number, default: 1 } },
  baseline: { value: { type: Number, default: 0 }, capturedAt: Date, version: { type: Number, default: 1 } },
  qualityConfig: {
    physicalMin: Number,
    physicalMax: Number,
    maxStep: Number,
    maxRatePerHour: Number,
    stuckTolerance: Number
  },
  enabled: { type: Boolean, default: true },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
sensorChannelSchema.index({ instrumentId: 1, code: 1 }, { unique: true });

const deviceSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  deviceId: { type: String, required: true },
  name: { type: String, required: true },
  deviceType: { type: String, default: 'LOGGER' },
  transport: { type: String, default: '4G' },
  firmware: String,
  apiKeyHash: String,
  apiKeyPrefix: String,
  status: { type: String, enum: ['PLANNED', 'ONLINE', 'OFFLINE', 'MAINTENANCE', 'DECOMMISSIONED'], default: 'PLANNED' },
  healthGrade: { type: String, enum: ['H0', 'H1', 'H2', 'H3', 'H4'], default: 'H0' },
  lastSeenAt: Date,
  lastBatteryV: Number,
  lastRssiDbm: Number,
  expectedIntervalSec: { type: Number, default: 900 },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
deviceSchema.index({ organizationId: 1, deviceId: 1 }, { unique: true });
deviceSchema.index({ projectId: 1, deviceType: 1 });

const calibrationVersionSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true },
  channelId: { type: Schema.Types.ObjectId, ref: 'SensorChannel' },
  version: { type: Number, required: true },
  coefficients: { type: Schema.Types.Mixed, required: true },
  certificateDocumentId: { type: Schema.Types.ObjectId, ref: 'Document' },
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'SUPERSEDED'], default: 'ACTIVE' },
  reason: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const baselineVersionSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true },
  channelId: { type: Schema.Types.ObjectId, ref: 'SensorChannel' },
  version: { type: Number, required: true },
  value: { type: Number, required: true },
  method: { type: String, default: 'SINGLE_POINT' },
  windowStart: Date,
  windowEnd: Date,
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'SUPERSEDED'], default: 'ACTIVE' },
  reason: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });


const deviceCommandSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  deviceMongoId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  commandId: { type: String, required: true, unique: true },
  commandType: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['QUEUED','ACCEPTED','EXECUTED','FAILED','EXPIRED'], default: 'QUEUED' },
  expiresAt: Date,
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  acknowledgedAt: Date,
  result: Schema.Types.Mixed,
  failureReason: String
}, { timestamps: true });
deviceCommandSchema.index({ deviceMongoId: 1, status: 1, createdAt: 1 });

export const Instrument = model('Instrument', instrumentSchema);
export const SensorChannel = model('SensorChannel', sensorChannelSchema);
export const Device = model('Device', deviceSchema);
export const CalibrationVersion = model('CalibrationVersion', calibrationVersionSchema);
export const BaselineVersion = model('BaselineVersion', baselineVersionSchema);
export const DeviceCommand = model('DeviceCommand', deviceCommandSchema);
