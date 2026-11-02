import mongoose from 'mongoose';
import { Counter } from './sensor.js';

const { Schema, model } = mongoose;

export const CANONICAL_TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
export const CANONICAL_TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const CANONICAL_TASK_RELATED_OBJECT_TYPES = [
  'INSTRUMENT',
  'DEVICE',
  'ALARM',
  'INVESTIGATION',
  'SITE',
  'NONE'
];
export const CANONICAL_TASK_UPDATE_TYPES = ['COMMENT', 'PROGRESS', 'SYSTEM'];
export const CANONICAL_TASK_EVENT_TYPES = [
  'CREATED',
  'ASSIGNED',
  'REASSIGNED',
  'UNASSIGNED',
  'STARTED',
  'UPDATED',
  'COMPLETED',
  'CANCELLED',
  'PRIORITY_CHANGED',
  'DUE_DATE_CHANGED'
];

const assignedTeamSnapshotSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: 'Team' },
  teamCode: String,
  teamName: String
}, { _id: false });

const assignedUserSnapshotSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  displayName: String,
  email: String,
  employeeCode: String,
  role: String
}, { _id: false });

const createdBySnapshotSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  displayName: String,
  email: String
}, { _id: false });

const taskSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },

  taskCode: { type: String, unique: true, sparse: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },

  status: {
    type: String,
    enum: CANONICAL_TASK_STATUSES,
    default: 'OPEN',
    index: true
  },

  priority: {
    type: String,
    enum: CANONICAL_TASK_PRIORITIES,
    default: 'MEDIUM',
    index: true
  },

  dueDate: { type: Date, index: true },

  // Flexible assignment: Team only, Employee only, or Team + Employee
  assignedTeamId: { type: Schema.Types.ObjectId, ref: 'Team', index: true },
  assignedTeamSnapshot: { type: assignedTeamSnapshotSchema },
  assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  assignedUserSnapshot: { type: assignedUserSnapshotSchema },
  assignedAt: Date,

  // Creator metadata
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  createdBySnapshot: { type: createdBySnapshotSchema },

  // Execution tracking
  startedAt: Date,
  startedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },

  completedAt: Date,
  completedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  completionNote: { type: String, trim: true },

  cancelledAt: Date,
  cancelledByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  cancellationReason: { type: String, trim: true },

  // Loosely-coupled Related Object
  relatedObjectType: {
    type: String,
    enum: CANONICAL_TASK_RELATED_OBJECT_TYPES,
    default: 'NONE',
    index: true
  },
  relatedObjectId: { type: Schema.Types.ObjectId, index: true },
  relatedObjectSnapshot: { type: Schema.Types.Mixed, default: null }
}, { timestamps: true });

taskSchema.index({ organizationId: 1, projectId: 1, status: 1 });
taskSchema.index({ organizationId: 1, projectId: 1, assignedUserId: 1 });
taskSchema.index({ organizationId: 1, projectId: 1, assignedTeamId: 1 });
taskSchema.index({ organizationId: 1, projectId: 1, dueDate: 1 });
taskSchema.index({ organizationId: 1, projectId: 1, relatedObjectType: 1, relatedObjectId: 1 });

taskSchema.pre('save', async function (next) {
  if (this.isNew && !this.taskCode) {
    try {
      const year = new Date().getFullYear();
      const counter = await Counter.findByIdAndUpdate(
        { _id: `taskCode_${year}` },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.taskCode = `TASK-${year}-${String(counter.seq).padStart(4, '0')}`;
      next();
    } catch (err) {
      next(err);
    }
  } else {
    next();
  }
});

const taskUpdateSchema = new Schema({
  taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  userSnapshot: {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    displayName: String,
    email: String,
    employeeCode: String
  },
  message: { type: String, required: true, trim: true },
  updateType: {
    type: String,
    enum: CANONICAL_TASK_UPDATE_TYPES,
    default: 'COMMENT'
  }
}, { timestamps: true });

taskUpdateSchema.index({ taskId: 1, createdAt: 1 });
taskUpdateSchema.index({ organizationId: 1, projectId: 1, createdAt: -1 });

const taskEventSchema = new Schema({
  taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  eventType: {
    type: String,
    enum: CANONICAL_TASK_EVENT_TYPES,
    required: true,
    index: true
  },
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorEmail: String,
  actorDisplayName: String,
  previousValue: { type: Schema.Types.Mixed },
  newValue: { type: Schema.Types.Mixed },
  comment: String,
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

taskEventSchema.index({ taskId: 1, createdAt: 1 });
taskEventSchema.index({ organizationId: 1, projectId: 1, createdAt: -1 });

export const Task = model('Task', taskSchema);
export const TaskUpdate = model('TaskUpdate', taskUpdateSchema);
export const TaskEvent = model('TaskEvent', taskEventSchema);
