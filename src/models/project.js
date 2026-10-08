import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const projectSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true },
  code: { type: String, required: true, uppercase: true, trim: true },
  clientName: String,
  location: String,
  timezone: { type: String, default: 'Asia/Kolkata' },
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  setupStatus: { type: String, enum: ['SETUP_REQUIRED', 'COMMISSIONING', 'COMMISSIONED'] },
  templateId: { type: Schema.Types.ObjectId, ref: 'ProjectTemplate' },
  templateUid: String,
  templateName: String,
  plannedConfiguration: {
    sensors: [{
      sensor_uid: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      name: String,
      model: String,
      signal_type: String
    }],
    devices: [{
      device_uid: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      name: String,
      model: String,
      communication: String,
      supported_signal_types: [String]
    }],
    gateways: [{
      gateway_uid: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      name: String,
      model: String,
      supported_device_communications: [String],
      backhaul: [String]
    }]
  },
  useCaseTemplateId: { type: Schema.Types.ObjectId, ref: 'UseCaseTemplate', required: false },
  useCaseCode: { type: String, required: false },
  dashboardTemplateId: { type: Schema.Types.ObjectId, ref: 'DashboardTemplate' },
  ruleSetId: { type: Schema.Types.ObjectId, ref: 'RuleSet' },
  correlations: { type: [String], default: [] },
  coordinateSystem: String,
  tarpVersion: String,
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
projectSchema.index({ organizationId: 1, code: 1 }, { unique: true });

const siteSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true },
  code: String,
  type: { type: String, default: 'SITE' },
  parentId: { type: Schema.Types.ObjectId, ref: 'Site' },
  level: { type: Number, default: 0 },
  geometry: Schema.Types.Mixed,
  chainageBasis: String,
  mapExtent: Schema.Types.Mixed,
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const zoneSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
  name: { type: String, required: true },
  code: String,
  type: { type: String, default: 'ZONE' },
  geometry: Schema.Types.Mixed,
  designNotes: String,
  responsibleEngineerId: { type: Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

export const Project = model('Project', projectSchema);
export const Site = model('Site', siteSchema);
export const Zone = model('Zone', zoneSchema);
