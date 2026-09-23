import { Notification, ProjectMember, User } from '../models/index.js';

export async function queueAlarmNotifications({ alarm, decision, emit = () => {} }) {
  const members = await ProjectMember.find({ projectId: alarm.projectId, status: 'ACTIVE', role: { $in: ['ADMINISTRATOR', 'ENGINEER', 'OPERATOR'] } }).lean();
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) }, status: 'ACTIVE' }).lean();
  const payload = {
    alarmId: alarm._id,
    projectId: alarm.projectId,
    severity: alarm.severity,
    healthGrade: alarm.healthGrade,
    state: alarm.state,
    title: alarm.title,
    reasons: alarm.reasonCodes,
    decisionId: decision?._id
  };
  const docs = users.map((u) => ({
    organizationId: alarm.organizationId,
    projectId: alarm.projectId,
    alarmId: alarm._id,
    decisionId: decision?._id,
    channel: 'IN_APP',
    recipient: u.email,
    templateCode: 'ALARM_CHANGED',
    status: 'SENT',
    payload,
    sentAt: new Date()
  }));
  if (docs.length) await Notification.insertMany(docs);
  emit('alarm.changed', payload);
  return docs.length;
}
