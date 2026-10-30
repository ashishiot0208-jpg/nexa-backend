import mongoose from 'mongoose';
import { Counter } from './sensor.js';

const { Schema, model } = mongoose;

export const CANONICAL_INVESTIGATION_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED'];
export const CANONICAL_INVESTIGATION_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const CANONICAL_INVESTIGATION_NOTE_TYPES = ['FINDING', 'NOTE', 'OBSERVATION', 'ROOT_CAUSE', 'ACTION_ITEM'];
export const CANONICAL_INVESTIGATION_EVENT_TYPES = [
  'CREATED',
  'ASSIGNED',
  'REASSIGNED',
  'UNASSIGNED',
  'STARTED',
  'FINDING_ADDED',
  'COMPLETED',
  'UPDATED'
];

const alarmSnapshotSchema = new Schema({
  alarmId: { type: Schema.Types.ObjectId, ref: 'Alarm' },
  title: String,
  category: String,
  initialSeverity: String,
  currentSeverity: String,
  highestSeverity: String,
  parameterCode: String,
  triggeredAt: Date,
  status: String
}, { _id: false });

const assignedTeamSnapshotSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: 'Team' },
  teamCode: String,
  teamName: String
}, { _id: false });

const assignedUserSnapshotSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  displayName: String,
  employeeCode: String,
  designation: String
}, { _id: false });

const investigationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },

  investigationCode: { type: String, unique: true, sparse: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },

  status: {
    type: String,
    enum: CANONICAL_INVESTIGATION_STATUSES,
    default: 'OPEN',
    index: true
  },

  // Linked Alarm (optional but strongly supported)
  alarmId: { type: Schema.Types.ObjectId, ref: 'Alarm', index: true },
  alarmSnapshot: { type: alarmSnapshotSchema },

  // Linked Geotechnical Assets
  instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', index: true },
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', index: true },
  gatewayId: { type: Schema.Types.ObjectId, ref: 'ProjectGateway', index: true },

  parameterCode: String,
  category: String,
  source: String,

  priority: {
    type: String,
    enum: CANONICAL_INVESTIGATION_PRIORITIES,
    default: 'MEDIUM'
  },

  // Assignment (Phase A1E: Team + Individual)
  assignedTeamId: { type: Schema.Types.ObjectId, ref: 'Team', index: true },
  assignedTeamSnapshot: { type: assignedTeamSnapshotSchema },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  assignedUserSnapshot: { type: assignedUserSnapshotSchema },
  assignedAt: Date,

  // Investigation Lifecycle Execution
  startedAt: Date,
  startedBy: { type: Schema.Types.ObjectId, ref: 'User' },

  completedAt: Date,
  completedBy: { type: Schema.Types.ObjectId, ref: 'User' },

  // Findings & Closure
  conclusion: { type: String, trim: true },
  rootCause: { type: String, trim: true },
  recommendedAction: { type: String, trim: true },

  // Tracking
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },

  lifecycleVersion: { type: Number, default: 1, index: true }
}, { timestamps: true });

investigationSchema.index({ projectId: 1, status: 1 });
investigationSchema.index({ projectId: 1, alarmId: 1 });
investigationSchema.index({ projectId: 1, instrumentId: 1 });
investigationSchema.index({ projectId: 1, assignedTo: 1 });
investigationSchema.index({ projectId: 1, assignedTeamId: 1 });

investigationSchema.pre('save', async function (next) {
  if (this.isNew && !this.investigationCode) {
    try {
      const year = new Date().getFullYear();
      const counter = await Counter.findByIdAndUpdate(
        { _id: `investigationCode_${year}` },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.investigationCode = `INV-${year}-${String(counter.seq).padStart(4, '0')}`;
      next();
    } catch (err) {
      next(err);
    }
  } else {
    next();
  }
});

const investigationEventSchema = new Schema({
  investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  actorType: { type: String, enum: ['USER', 'SYSTEM', 'SERVICE'], default: 'USER' },
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorEmail: String,
  actorDisplayName: String,
  eventType: {
    type: String,
    enum: CANONICAL_INVESTIGATION_EVENT_TYPES,
    required: true,
    index: true
  },
  previousStatus: String,
  newStatus: String,
  comment: String,
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

investigationEventSchema.index({ investigationId: 1, createdAt: 1 });
investigationEventSchema.index({ projectId: 1, createdAt: -1 });

const investigationNoteSchema = new Schema({
  investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  type: {
    type: String,
    enum: CANONICAL_INVESTIGATION_NOTE_TYPES,
    default: 'FINDING',
    index: true
  },
  text: { type: String, required: true, trim: true },
  evidenceReferences: { type: [Schema.Types.Mixed], default: [] },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  actorEmail: String,
  actorDisplayName: String
}, { timestamps: true });

investigationNoteSchema.index({ investigationId: 1, createdAt: 1 });

export const Investigation = mongoose.models.Investigation || model('Investigation', investigationSchema);
export const InvestigationEvent = mongoose.models.InvestigationEvent || model('InvestigationEvent', investigationEventSchema);
export const InvestigationNote = mongoose.models.InvestigationNote || model('InvestigationNote', investigationNoteSchema);
