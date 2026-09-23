import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const correlationModelSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true },
  purpose: String,
  scope: { type: Schema.Types.Mixed, default: {} },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACTIVE', 'RETIRED'], default: 'DRAFT' },
  activeVersion: Number,
  versions: [{
    version: Number,
    graphJson: Schema.Types.Mixed,
    schemaVersion: { type: Number, default: 1 },
    validationResult: Schema.Types.Mixed,
    status: { type: String, default: 'DRAFT' },
    checksum: String,
    submittedAt: Date,
    approvedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  }]
}, { timestamps: true });

const backtestRunSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  modelId: { type: Schema.Types.ObjectId, ref: 'CorrelationModel', required: true },
  modelVersion: { type: Number, required: true },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  status: { type: String, enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'], default: 'QUEUED' },
  progress: { type: Number, default: 0 },
  metrics: Schema.Types.Mixed,
  timeline: { type: [Schema.Types.Mixed], default: [] },
  nodeDiagnostics: Schema.Types.Mixed,
  error: String,
  startedAt: Date,
  finishedAt: Date
}, { timestamps: true });

const cameraSourceSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
  zoneId: { type: Schema.Types.ObjectId, ref: 'Zone' },
  name: { type: String, required: true },
  sourceMode: { type: String, enum: ['SNAPSHOT', 'RTSP_GATEWAY', 'MANUAL'], default: 'SNAPSHOT' },
  sourceUrl: String,
  credentialSecretRef: String,
  expectedCaptureSec: Number,
  timezone: String,
  healthState: { type: String, enum: ['ONLINE', 'STALE', 'OFFLINE', 'UNKNOWN'], default: 'UNKNOWN' },
  lastImageAt: Date,
  metadata: Schema.Types.Mixed
}, { timestamps: true });
cameraSourceSchema.index({ projectId: 1 });

const mediaAssetSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  cameraId: { type: Schema.Types.ObjectId, ref: 'CameraSource' },
  captureAt: Date,
  receivedAt: { type: Date, default: Date.now },
  filename: String,
  mimeType: String,
  size: Number,
  storagePath: String,
  hash: String,
  source: { type: String, default: 'UPLOAD' },
  annotations: { type: [Schema.Types.Mixed], default: [] },
  relatedAlarmIds: [{ type: Schema.Types.ObjectId, ref: 'Alarm' }],
  metadata: Schema.Types.Mixed
}, { timestamps: true });

const documentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument' },
  category: { type: String, default: 'GENERAL' },
  title: { type: String, required: true },
  filename: String,
  mimeType: String,
  size: Number,
  storagePath: String,
  hash: String,
  version: { type: Number, default: 1 },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  metadata: Schema.Types.Mixed
}, { timestamps: true });

const logbookEventSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
  zoneId: { type: Schema.Types.ObjectId, ref: 'Zone' },
  eventType: { type: String, required: true },
  occurredAt: { type: Date, required: true },
  title: { type: String, required: true },
  description: String,
  attachments: [{ type: Schema.Types.ObjectId, ref: 'Document' }],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  metadata: Schema.Types.Mixed
}, { timestamps: true });

const reportSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  name: { type: String, required: true },
  reportType: { type: String, default: 'PROJECT_SUMMARY' },
  periodStart: Date,
  periodEnd: Date,
  status: { type: String, enum: ['QUEUED', 'GENERATING', 'READY', 'FAILED'], default: 'QUEUED' },
  filename: String,
  storagePath: String,
  generatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  error: String,
  metadata: Schema.Types.Mixed
}, { timestamps: true });

export const CorrelationModel = model('CorrelationModel', correlationModelSchema);
export const BacktestRun = model('BacktestRun', backtestRunSchema);
export const CameraSource = model('CameraSource', cameraSourceSchema);
export const MediaAsset = model('MediaAsset', mediaAssetSchema);
export const Document = model('Document', documentSchema);
export const LogbookEvent = model('LogbookEvent', logbookEventSchema);
export const Report = model('Report', reportSchema);
