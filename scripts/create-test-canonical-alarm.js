#!/usr/bin/env node

/**
 * DEVELOPMENT TEST SCRIPT — CREATE SYNTHETIC CANONICAL ALARM
 *
 * Used for Phase C6B UI testing without implementing C6C automatic triggers.
 * Uses alarm.service.js (NOT direct MongoDB insert).
 *
 * Usage:
 *   node scripts/create-test-canonical-alarm.js
 *   node scripts/create-test-canonical-alarm.js --clean
 */

import mongoose from 'mongoose';
import { Project, Instrument, Alarm, AlarmEvent, EngineeringSeverityRule } from '../src/models/index.js';
import { createAlarm } from '../src/services/alarm.service.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa';

async function main() {
  const isClean = process.argv.includes('--clean');

  await mongoose.connect(MONGO_URI);
  console.log(`[DB] Connected to ${MONGO_URI}`);

  try {
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    if (!project) {
      throw new Error('Project LAN-PRO-01 not found');
    }

    const instrument = await Instrument.findOne({
      projectId: project._id,
      code: 'INC-2026-0001'
    });

    if (!instrument) {
      throw new Error('Instrument INC-2026-0001 not found');
    }

    if (isClean) {
      console.log('\n--- Cleaning up synthetic development test alarms ---');
      const testAlarms = await Alarm.find({
        projectId: project._id,
        summary: { $regex: /DEVELOPMENT TEST/i }
      });

      for (const al of testAlarms) {
        await AlarmEvent.deleteMany({ alarmId: al._id });
        await Alarm.deleteOne({ _id: al._id });
        console.log(`[CLEANED] Alarm ${al._id} (${al.title}) and its events deleted.`);
      }

      console.log('[DONE] All synthetic test alarms cleaned up.');
      await mongoose.disconnect();
      return;
    }

    console.log('\n--- Creating canonical DEVELOPMENT TEST alarm ---');

    // Check if an active test alarm already exists
    const existing = await Alarm.findOne({
      projectId: project._id,
      instrumentId: instrument._id,
      category: 'ENGINEERING_SEVERITY',
      status: { $in: ['OPEN', 'ACKNOWLEDGED'] },
      summary: { $regex: /DEVELOPMENT TEST/i }
    });

    if (existing) {
      console.log(`[EXISTS] Synthetic test alarm already exists: ${existing._id} (Status: ${existing.status})`);
      console.log('To clean up first, run: node scripts/create-test-canonical-alarm.js --clean');
      await mongoose.disconnect();
      return;
    }

    // Lookup existing severity rule if available
    const rule = await EngineeringSeverityRule.findOne({
      projectId: project._id,
      parameterCode: 'x_displacement',
      status: 'ACTIVE'
    });

    const result = await createAlarm({
      organizationId: project.organizationId,
      projectId: project._id,
      category: 'ENGINEERING_SEVERITY',
      title: 'Accelerating slope movement — Test Advisory',
      summary: 'DEVELOPMENT TEST: Synthetic S2 displacement advisory on INC-2026-0001 for C6B UI workflow verification',
      reason: 'THRESHOLD_S2_EXCEEDED',
      instrumentId: instrument._id,
      parameterCode: 'x_displacement',
      initialSeverity: 'S2',
      engineeringSnapshot: {
        severityLevel: 'S2',
        ruleId: rule?._id || new mongoose.Types.ObjectId(),
        ruleVersion: rule?.version || 1,
        metric: 'engineeringValue',
        evaluatedValue: 2.85,
        unit: 'mm',
        observedAt: new Date(),
        severityEvaluatedAt: new Date(),
        reason: 'THRESHOLD_S2_EXCEEDED'
      },
      actor: {
        actorType: 'SYSTEM',
        displayName: 'Dev Seed Script'
      },
      comment: 'Synthetic canonical test alarm created via alarm.service.js for Phase C6B UI validation.'
    });

    console.log('\n======================================================');
    console.log('DEVELOPMENT TEST CANONICAL ALARM CREATED');
    console.log('======================================================');
    console.log(`Alarm ID:         ${result.alarm._id}`);
    console.log(`Title:            ${result.alarm.title}`);
    console.log(`Category:         ${result.alarm.category}`);
    console.log(`Status:           ${result.alarm.status}`);
    console.log(`LifecycleVersion: ${result.alarm.lifecycleVersion}`);
    console.log(`Current Severity: ${result.alarm.currentSeverity}`);
    console.log(`Instrument:       ${instrument.code} (${instrument.name})`);
    console.log(`Project:          ${project.name} (${project._id})`);
    console.log('======================================================\n');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
