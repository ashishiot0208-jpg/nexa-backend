import mongoose from 'mongoose';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import { Alarm, AlarmEvent } from '../src/models/decision.js';
import { getAlarm } from '../src/services/alarm.service.js';

async function verify() {
  await mongoose.connect(process.env.MONGODB_URI);

  const canonical = await Alarm.findById('6ad0d886fca52330dfb4d3f8').lean();
  if (!canonical) throw new Error('Canonical alarm not found');

  console.log('=== 1. Canonical Alarm Record ===');
  console.log('ID:', canonical._id.toString());
  console.log('Title:', canonical.title);
  console.log('Status:', canonical.status);
  console.log('Initial Severity:', canonical.initialSeverity);
  console.log('Current Severity:', canonical.currentSeverity);
  console.log('Highest Severity:', canonical.highestSeverity);

  console.log('\n=== 2. Raw AlarmEvent Records in MongoDB ===');
  const rawEvents = await AlarmEvent.find({ alarmId: canonical._id }).sort({ createdAt: 1 }).lean();
  console.log('Total AlarmEvents count:', rawEvents.length);
  rawEvents.forEach((e, i) => {
    console.log(`[${i + 1}] Event Type: ${e.eventType}`);
    console.log(`    Timestamp: ${e.createdAt.toISOString()}`);
    console.log(`    Actor: ${e.actorDisplayName || e.actorEmail || e.actorType}`);
    console.log(`    Alarm ID: ${e.alarmId.toString()}`);
    console.log(`    Project ID: ${e.projectId.toString()}`);
    if (e.eventType === 'CREATED') {
      console.log(`    Triggered by: ${e.metadata?.policyName} · v${e.metadata?.alarmPolicyVersion}`);
      console.log(`    Initial severity: ${e.metadata?.initialSeverity || e.metadata?.severity}`);
      console.log(`    Evaluated value: ${e.metadata?.evaluatedValue} ${e.metadata?.unit}`);
    } else if (e.eventType === 'ESCALATED') {
      console.log(`    Severity transition: ${e.metadata?.previousSeverity} -> ${e.metadata?.newSeverity}`);
      console.log(`    Evaluated value: ${e.metadata?.evaluatedValue} ${e.metadata?.unit}`);
    }
  });

  console.log('\n=== 3. Detail API Response Verification ===');
  const apiRes1 = await getAlarm({
    alarmId: canonical._id.toString(),
    projectId: canonical.projectId,
    organizationId: canonical.organizationId
  });
  console.log('API response keys:', Object.keys(apiRes1));
  console.log('events array property present:', Array.isArray(apiRes1.events));
  console.log('events length in API response:', apiRes1.events.length);

  const apiRes2 = await getAlarm({
    alarmId: 'ALM-B4D3F8',
    projectId: canonical.projectId,
    organizationId: canonical.organizationId
  });
  console.log('API response by display code ALM-B4D3F8 events length:', apiRes2.events.length);

  console.log('\n=== 4. Side Effects and Invariants Check ===');
  const postEventsCount = await AlarmEvent.countDocuments({ alarmId: canonical._id });
  console.log('Events count unchanged (read-only):', postEventsCount === 4);

  const openCount = await Alarm.countDocuments({ lifecycleVersion: 2, status: 'OPEN' });
  const ackCount = await Alarm.countDocuments({ lifecycleVersion: 2, status: 'ACKNOWLEDGED' });
  const resCount = await Alarm.countDocuments({ lifecycleVersion: 2, status: 'RESOLVED' });
  const totalCount = await Alarm.countDocuments({ lifecycleVersion: 2 });
  console.log('Canonical alarm counts:', { openCount, ackCount, resCount, totalCount });

  const legacyCount = await Alarm.countDocuments({
    $or: [{ lifecycleVersion: { $exists: false } }, { lifecycleVersion: 1 }]
  });
  console.log('Legacy alarm count:', legacyCount);

  await mongoose.disconnect();
}

verify().catch((err) => {
  console.error(err);
  process.exit(1);
});
