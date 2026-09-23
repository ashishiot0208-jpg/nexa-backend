import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const decisionSnapshotSchema = new Schema({
  decisionCode: { type: String, required: true, unique: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },
  evaluatedAt: { type: Date, required: true, index: true },
  severity: { type: String, enum: ['S0', 'S1', 'S2', 'S3', 'S4'], required: true },
  severityFloor: { type: String, enum: ['S0', 'S1', 'S2', 'S3', 'S4'], required: true },
  confidence: { type: Number, min: 0, max: 100, required: true },
  confidenceBand: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], required: true },
  monitoringHealth: { type: String, enum: ['H0', 'H1', 'H2', 'H3', 'H4'], required: true },
  state: { type: String, default: 'NORMAL' },
  reasonCodes: { type: [String], default: [] },
  matchedRules: { type: [Schema.Types.Mixed], default: [] },
  evidence: { type: [Schema.Types.Mixed], default: [] },
  recommendedActions: { type: [String], default: [] },
  ruleSetId: { type: Schema.Types.ObjectId, ref: 'RuleSet' },
  ruleSetVersion: Number,
  graphVersionId: String,
  inputReadingIds: [{ type: Schema.Types.ObjectId, ref: 'DerivedReading' }],
  trace: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
decisionSnapshotSchema.index({ projectId: 1, evaluatedAt: -1 });

const alarmSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument' },
  type: { type: String, enum: ['ENGINEERING', 'MONITORING_HEALTH', 'CONFIGURATION'], default: 'ENGINEERING' },
  title: { type: String, required: true },
  severity: { type: String, default: 'S0' },
  healthGrade: { type: String, default: 'H0' },
  state: { type: String, enum: ['TRIGGERED', 'ACKNOWLEDGED', 'UNDER_INVESTIGATION', 'ACTION_IN_PROGRESS', 'ESCALATED', 'CONDITION_NORMALIZED', 'CLOSED'], default: 'TRIGGERED' },
  decisionId: { type: Schema.Types.ObjectId, ref: 'DecisionSnapshot' },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  openedAt: { type: Date, default: Date.now },
  acknowledgedAt: Date,
  normalizedAt: Date,
  closedAt: Date,
  acknowledgementDueAt: Date,
  reasonCodes: { type: [String], default: [] },
  resolutionCode: String,
  lastComment: String,
  activeKey: { type: String }
}, { timestamps: true });
alarmSchema.index({ projectId: 1, state: 1, severity: 1 });
alarmSchema.index({ activeKey: 1 }, { unique: true, sparse: true });

const alarmEventSchema = new Schema({
  alarmId: { type: Schema.Types.ObjectId, ref: 'Alarm', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  actorType: { type: String, enum: ['USER', 'SYSTEM', 'SERVICE'], default: 'SYSTEM' },
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  eventType: { type: String, required: true },
  fromState: String,
  toState: String,
  comment: String,
  actionCode: String,
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const notificationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  alarmId: { type: Schema.Types.ObjectId, ref: 'Alarm' },
  decisionId: { type: Schema.Types.ObjectId, ref: 'DecisionSnapshot' },
  channel: { type: String, enum: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK', 'VOICE'], default: 'IN_APP' },
  recipient: String,
  templateCode: String,
  status: { type: String, enum: ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'], default: 'QUEUED' },
  payload: { type: Schema.Types.Mixed, default: {} },
  sentAt: Date,
  failureReason: String
}, { timestamps: true });

const auditEventSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  actorType: { type: String, enum: ['USER', 'SYSTEM', 'DEVICE', 'SERVICE'], default: 'SYSTEM' },
  actorId: String,
  action: { type: String, required: true },
  resourceType: { type: String, required: true },
  resourceId: String,
  previousState: Schema.Types.Mixed,
  newState: Schema.Types.Mixed,
  reason: String,
  correlationId: String,
  ip: String
}, { timestamps: true });
auditEventSchema.index({ projectId: 1, createdAt: -1 });

export const DecisionSnapshot = model('DecisionSnapshot', decisionSnapshotSchema);
export const Alarm = model('Alarm', alarmSchema);
export const AlarmEvent = model('AlarmEvent', alarmEventSchema);
export const Notification = model('Notification', notificationSchema);
export const AuditEvent = model('AuditEvent', auditEventSchema);
