import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const useCaseTemplateSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  name: { type: String, required: true },
  summary: String,
  recommendedHierarchy: { type: [String], default: [] },
  recommendedInstruments: { type: [String], default: [] },
  recommendedCorrelations: { type: [String], default: [] },
  terminology: { type: Schema.Types.Mixed, default: {} },
  dashboardTemplateName: String,
  navigationEmphasis: { type: [String], default: [] },
  version: { type: Number, default: 1 },
  status: { type: String, enum: ['DRAFT', 'APPROVED', 'RETIRED'], default: 'APPROVED' }
}, { timestamps: true });

const instrumentCatalogSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  parameters: { type: [Schema.Types.Mixed], default: [] },
  defaultVisualizations: { type: [String], default: [] },
  defaultChannels: { type: [Schema.Types.Mixed], default: [] },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const dashboardTemplateSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  name: { type: String, required: true },
  useCaseCodes: { type: [String], default: [] },
  version: { type: Number, default: 1 },
  status: { type: String, enum: ['DRAFT', 'APPROVED', 'RETIRED'], default: 'APPROVED' },
  widgets: { type: [Schema.Types.Mixed], default: [] },
  layout: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const ruleSetSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  code: { type: String, required: true, uppercase: true },
  name: { type: String, required: true },
  useCaseCodes: { type: [String], default: [] },
  version: { type: Number, default: 1 },
  status: { type: String, enum: ['DRAFT', 'APPROVED', 'ACTIVE', 'RETIRED'], default: 'APPROVED' },
  description: String,
  rules: { type: [Schema.Types.Mixed], default: [] },
  tarpActions: { type: Schema.Types.Mixed, default: {} },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date
}, { timestamps: true });
ruleSetSchema.index({ organizationId: 1, code: 1, version: 1 }, { unique: true });

const dashboardSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  templateType: String,
  currentPublishedVersionId: { type: Schema.Types.ObjectId, ref: 'DashboardVersion' },
  currentDraftVersionId: { type: Schema.Types.ObjectId, ref: 'DashboardVersion' }
}, { timestamps: true });

const dashboardVersionSchema = new Schema({
  dashboardId: { type: Schema.Types.ObjectId, ref: 'Dashboard', required: true, index: true },
  versionNo: { type: Number, required: true },
  status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'SUPERSEDED'], default: 'DRAFT' },
  layoutJson: { type: Schema.Types.Mixed, default: {} },
  schemaVersion: { type: Number, default: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  publishedAt: Date,
  checksum: String
}, { timestamps: true });
dashboardVersionSchema.index({ dashboardId: 1, versionNo: 1 }, { unique: true });

export const UseCaseTemplate = model('UseCaseTemplate', useCaseTemplateSchema);
export const InstrumentCatalog = model('InstrumentCatalog', instrumentCatalogSchema);
export const DashboardTemplate = model('DashboardTemplate', dashboardTemplateSchema);
export const RuleSet = model('RuleSet', ruleSetSchema);
export const Dashboard = model('Dashboard', dashboardSchema);
export const DashboardVersion = model('DashboardVersion', dashboardVersionSchema);
