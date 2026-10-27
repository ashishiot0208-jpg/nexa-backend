import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import {
  Alarm,
  AlarmEvent,
  Device,
  DeviceGatewayMapping,
  DerivedReading,
  EngineeringSeverityRule,
  Instrument,
  Investigation,
  InvestigationEvent,
  InvestigationNote,
  LatestState,
  Organization,
  OrganizationMember,
  Project,
  ProjectGateway,
  ProjectMember,
  RawReading,
  SensorChannel,
  SensorDeviceMapping,
  Site,
  User,
  Zone
} from '../src/models/index.js';

export async function ensureDevelopmentFixtures() {
  console.log('[FIXTURES] Checking / ensuring development fixtures...');
  
  // 1. Organization
  let org = await Organization.findOne();
  if (!org) {
    org = await Organization.create({
      name: 'GeoNexa Demonstration',
      code: 'GEONEXA-DEMO',
      timezone: 'Asia/Kolkata'
    });
  }

  // Ensure Admin & Viewer users
  let adminUser = await User.findOne({ email: 'admin@geonexa.test' }) || await User.findOne({ email: 'admin@geonexa.local' });
  if (!adminUser) {
    adminUser = await User.create({
      email: 'admin@geonexa.test',
      displayName: 'Test Admin',
      passwordHash: 'dummy'
    });
  }

  // 2. Project LAN-PRO-01
  let project = await Project.findOne({ code: 'LAN-PRO-01' });
  if (!project) {
    project = await Project.create({
      name: 'Landslide Project',
      code: 'LAN-PRO-01',
      organizationId: org._id,
      status: 'ACTIVE',
      setupStatus: 'COMMISSIONING',
      location: 'Section 4, North Ridge Slope',
      timezone: 'UTC'
    });
    console.log(`[FIXTURES] Created Project LAN-PRO-01 (${project._id})`);
  }

  // Ensure Admin and Viewer project membership
  await OrganizationMember.findOneAndUpdate(
    { organizationId: org._id, userId: adminUser._id },
    { organizationRole: 'ADMINISTRATOR', status: 'ACTIVE' },
    { upsert: true }
  );
  await ProjectMember.findOneAndUpdate(
    { projectId: project._id, userId: adminUser._id },
    { role: 'ADMINISTRATOR', status: 'ACTIVE' },
    { upsert: true }
  );

  // 3. Site and Zone
  let site = await Site.findOne({ projectId: project._id });
  if (!site) {
    site = await Site.create({
      projectId: project._id,
      organizationId: org._id,
      name: 'North Ridge Slope'
    });
  }
  let zone = await Zone.findOne({ projectId: project._id });
  if (!zone) {
    zone = await Zone.create({
      projectId: project._id,
      organizationId: org._id,
      siteId: site._id,
      name: 'Toe Sector 1'
    });
  }

  // 4. Instrument INC-2026-0001
  let instrument = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' });
  if (!instrument) {
    instrument = await Instrument.create({
      projectId: project._id,
      organizationId: org._id,
      siteId: site._id,
      zoneId: zone._id,
      code: 'INC-2026-0001',
      name: 'Automatic Inclinometer 01',
      catalogCode: 'INCLINOMETER',
      sensor_uid: 'SNS000004',
      status: 'COMMISSIONED',
      commissionedAt: new Date(),
      coordinates: [55.67, 25.33],
      depthM: 15.0,
      orientationDeg: 45.0,
      metadata: { model: 'INCL-PRO-2026' }
    });
    console.log(`[FIXTURES] Created Instrument INC-2026-0001 (${instrument._id})`);
  } else if (!instrument.coordinates || !instrument.coordinates.length) {
    instrument.coordinates = [55.67, 25.33];
    instrument.depthM = 15.0;
    instrument.orientationDeg = 45.0;
    await instrument.save();
  }

  // 5. SensorChannel x_displacement
  let channel = await SensorChannel.findOne({ instrumentId: instrument._id, parameterCode: 'x_displacement' });
  if (!channel) {
    channel = await SensorChannel.create({
      projectId: project._id,
      organizationId: org._id,
      instrumentId: instrument._id,
      code: 'x_displacement',
      parameterCode: 'x_displacement',
      rawUnit: 'mm',
      engineeringUnit: 'mm',
      baseline: { configured: true, value: 0.0, version: 1 },
      calibration: { configured: true, scale: 1.0, offset: 0.0, version: 1, source: 'DEVICE_NATIVE' }
    });
  }

  // 6. Device SNRS485-2026-0001
  let device = await Device.findOne({ projectId: project._id, deviceId: 'SNRS485-2026-0001' });
  if (!device) {
    device = await Device.create({
      projectId: project._id,
      organizationId: org._id,
      deviceId: 'SNRS485-2026-0001',
      name: 'RS485 Field Logger 01',
      deviceType: 'LOGGER',
      model: 'DL-RS485',
      status: 'COMMISSIONED',
      commissioningStatus: 'COMMISSIONED',
      runtimeStatus: 'ONLINE',
      lastSeenAt: new Date(),
      expectedIntervalSec: 900
    });
    console.log(`[FIXTURES] Created Device SNRS485-2026-0001 (${device._id})`);
  }

  // 7. ProjectGateway GWLR-2026-0001
  let gateway = await ProjectGateway.findOne({ projectId: project._id, gatewayId: 'GWLR-2026-0001' });
  if (!gateway) {
    gateway = await ProjectGateway.create({
      projectId: project._id,
      organizationId: org._id,
      gatewayId: 'GWLR-2026-0001',
      name: 'LoRaWAN Slope Gateway',
      gateway_uid: 'GW000001',
      model: 'GW-LR900',
      status: 'COMMISSIONED',
      metadata: { lastSeenAt: new Date() }
    });
    console.log(`[FIXTURES] Created Gateway GWLR-2026-0001 (${gateway._id})`);
  }

  // 7b. Severity Rule for x_displacement (1.4 mm -> S1)
  let rule = await EngineeringSeverityRule.findOne({ projectId: project._id, parameterCode: 'x_displacement', status: 'ACTIVE' });
  if (rule) {
    rule.metric = 'deltaFromBaseline';
    await rule.save();
  } else {
    rule = await EngineeringSeverityRule.create({
      projectId: project._id,
      organizationId: org._id,
      code: 'RULE-DISP-01',
      name: 'Slope Displacement Severity Rule',
      parameterCode: 'x_displacement',
      catalogCode: 'INCLINOMETER',
      metric: 'deltaFromBaseline',
      mode: 'INCREASING',
      unit: 'mm',
      thresholds: {
        s1: 1.0,
        s2: 2.5,
        s3: 4.0,
        s4: 5.0
      },
      status: 'ACTIVE',
      version: 1
    });
    console.log(`[FIXTURES] Created EngineeringSeverityRule (${rule._id})`);
  }

  // 8. Mappings
  let sdm = await SensorDeviceMapping.findOne({ projectId: project._id, sensorAssetId: instrument._id, status: 'ACTIVE' });
  if (!sdm) {
    await SensorDeviceMapping.create({
      projectId: project._id,
      organizationId: org._id,
      sensorAssetId: instrument._id,
      deviceAssetId: device._id,
      connection: { slot: 1, mode: 'slot' },
      status: 'ACTIVE'
    });
  }

  let dgm = await DeviceGatewayMapping.findOne({ projectId: project._id, deviceAssetId: device._id, status: 'ACTIVE' });
  if (!dgm) {
    await DeviceGatewayMapping.create({
      projectId: project._id,
      organizationId: org._id,
      deviceAssetId: device._id,
      gatewayAssetId: gateway._id,
      status: 'ACTIVE'
    });
  }

  // 9. Ensure legacy alarms count is exactly 5
  const legacyCount = await Alarm.countDocuments({
    $or: [
      { lifecycleVersion: 1 },
      { lifecycleVersion: { $exists: false } },
      { lifecycleVersion: null }
    ]
  });
  if (legacyCount < 5) {
    const toCreate = 5 - legacyCount;
    for (let i = 0; i < toCreate; i++) {
      await Alarm.create({
        projectId: project._id,
        organizationId: org._id,
        title: `Legacy Advisory Alarm ${i + 1}`,
        type: 'ENGINEERING',
        state: 'TRIGGERED'
      });
    }
    console.log(`[FIXTURES] Created ${toCreate} legacy alarms to match expected legacy baseline of 5`);
  }

  // 10. Persisted real Telemetry history for INC-2026-0001
  const latestDerivedCheck = await DerivedReading.findOne({ instrumentId: instrument._id }).sort({ observedAt: -1 }).lean();
  if (!latestDerivedCheck || latestDerivedCheck.value !== 1.40) {
    await RawReading.deleteMany({ instrumentId: instrument._id });
    await DerivedReading.deleteMany({ instrumentId: instrument._id });
    console.log('[FIXTURES] Creating sample real telemetry records for INC-2026-0001...');
    const now = Date.now();
    const timestamps = [
      new Date(now - 48 * 3600 * 1000),
      new Date(now - 36 * 3600 * 1000),
      new Date(now - 24 * 3600 * 1000),
      new Date(now - 12 * 3600 * 1000),
      new Date(now - 4 * 3600 * 1000),
      new Date(now - 1 * 3600 * 1000)
    ];
    const values = [1.05, 1.15, 1.25, 1.30, 1.35, 1.40];

    for (let i = 0; i < timestamps.length; i++) {
      const raw = await RawReading.create({
        ingestionId: `fixture-raw-${Date.now()}-${i}`,
        messageId: `fixture-msg-${Date.now()}-${i}`,
        organizationId: org._id,
        projectId: project._id,
        deviceId: device._id,
        instrumentId: instrument._id,
        channelId: channel._id,
        channelCode: 'x_displacement',
        sampleTime: timestamps[i],
        rawValue: values[i],
        rawUnit: 'mm',
        quality: 'VALID',
        originalPacket: { fixture: true }
      });

      await DerivedReading.create({
        organizationId: org._id,
        projectId: project._id,
        instrumentId: instrument._id,
        channelId: channel._id,
        rawReadingId: raw._id,
        parameterCode: 'x_displacement',
        observedAt: timestamps[i],
        value: values[i],
        unit: 'mm',
        deltaFromBaseline: values[i],
        quality: 'VALID',
        severity: {
          evaluated: true,
          level: 'S1',
          evaluatedAt: timestamps[i]
        }
      });
    }

    // LatestState
    await LatestState.findOneAndUpdate(
      { instrumentId: instrument._id, parameterCode: 'x_displacement' },
      {
        organizationId: org._id,
        projectId: project._id,
        instrumentId: instrument._id,
        parameterCode: 'x_displacement',
        observedAt: timestamps[timestamps.length - 1],
        value: values[values.length - 1],
        unit: 'mm',
        quality: 'VALID',
        severity: 'S1',
        severityDetails: {
          evaluated: true,
          level: 'S1',
          evaluatedValue: values[values.length - 1],
          unit: 'mm',
          evaluatedAt: timestamps[timestamps.length - 1]
        }
      },
      { upsert: true }
    );
  }

  // 11. Canonical Alarm ALM-B4D3F8 (resolved, S4, lifecycleVersion: 2)
  let canonicalAlarm = await Alarm.findOne({
    projectId: project._id,
    lifecycleVersion: 2,
    status: 'RESOLVED'
  });

  if (canonicalAlarm && canonicalAlarm.state !== 'CLOSED') {
    canonicalAlarm.state = 'CLOSED';
    await canonicalAlarm.save();
  }

  if (!canonicalAlarm) {
    canonicalAlarm = await Alarm.create({
      organizationId: org._id,
      projectId: project._id,
      instrumentId: instrument._id,
      category: 'ENGINEERING_SEVERITY',
      title: 'INC-2026-0001 · X displacement',
      summary: 'DEVELOPMENT TEST: Lateral displacement escalated to S4 and resolved',
      reason: 'THRESHOLD_S4_EXCEEDED',
      parameterCode: 'x_displacement',
      initialSeverity: 'S1',
      currentSeverity: 'S4',
      highestSeverity: 'S4',
      status: 'RESOLVED',
      state: 'CLOSED',
      lifecycleVersion: 2,
      triggeredAt: new Date(Date.now() - 48 * 3600 * 1000),
      acknowledgedAt: new Date(Date.now() - 36 * 3600 * 1000),
      acknowledgedBy: adminUser._id,
      resolvedAt: new Date(Date.now() - 12 * 3600 * 1000),
      resolvedBy: adminUser._id,
      resolutionReason: 'Stabilized after remedial grouting'
    });

    await AlarmEvent.create({
      alarmId: canonicalAlarm._id,
      projectId: project._id,
      actorType: 'SYSTEM',
      actorDisplayName: 'Severity Engine',
      eventType: 'CREATED',
      previousStatus: null,
      newStatus: 'OPEN',
      comment: 'Alarm triggered at S1',
      createdAt: canonicalAlarm.triggeredAt
    });

    await AlarmEvent.create({
      alarmId: canonicalAlarm._id,
      projectId: project._id,
      actorType: 'USER',
      actorId: adminUser._id,
      actorDisplayName: adminUser.displayName,
      eventType: 'ACKNOWLEDGED',
      previousStatus: 'OPEN',
      newStatus: 'ACKNOWLEDGED',
      comment: 'Operator acknowledged advisory',
      createdAt: canonicalAlarm.acknowledgedAt
    });

    await AlarmEvent.create({
      alarmId: canonicalAlarm._id,
      projectId: project._id,
      actorType: 'USER',
      actorId: adminUser._id,
      actorDisplayName: adminUser.displayName,
      eventType: 'RESOLVED',
      previousStatus: 'ACKNOWLEDGED',
      newStatus: 'RESOLVED',
      comment: 'Stabilized after remedial grouting',
      createdAt: canonicalAlarm.resolvedAt
    });
    console.log(`[FIXTURES] Created Canonical Alarm ALM-B4D3F8 (${canonicalAlarm._id})`);
  }

  // 12. Investigation INV-2026-0001
  let investigation = await Investigation.findOne({
    projectId: project._id,
    lifecycleVersion: 1
  });

  if (!investigation) {
    investigation = await Investigation.create({
      organizationId: org._id,
      projectId: project._id,
      investigationCode: 'INV-2026-0001',
      title: 'Investigation of INC-2026-0001 S4 Displacement',
      description: 'Development test investigation linked to resolved alarm INC-2026-0001',
      status: 'COMPLETED',
      priority: 'HIGH',
      lifecycleVersion: 1,
      alarmId: canonicalAlarm._id,
      alarmSnapshot: {
        alarmId: canonicalAlarm._id,
        title: canonicalAlarm.title,
        category: canonicalAlarm.category,
        initialSeverity: 'S1',
        currentSeverity: 'S4',
        highestSeverity: 'S4',
        parameterCode: 'x_displacement',
        triggeredAt: canonicalAlarm.triggeredAt,
        status: 'RESOLVED'
      },
      instrumentId: instrument._id,
      deviceId: device._id,
      gatewayId: gateway._id,
      parameterCode: 'x_displacement',
      category: 'ENGINEERING_SEVERITY',
      assignedTo: adminUser._id,
      assignedAt: new Date(Date.now() - 36 * 3600 * 1000),
      startedAt: new Date(Date.now() - 30 * 3600 * 1000),
      startedBy: adminUser._id,
      completedAt: new Date(Date.now() - 10 * 3600 * 1000),
      completedBy: adminUser._id,
      conclusion: 'Shear zone movement arrested',
      rootCause: 'Heavy precipitation elevated pore pressure causing transient toe creep',
      recommendedAction: 'Maintain bi-hourly automated telemetry monitoring',
      createdBy: adminUser._id
    });

    await InvestigationNote.create({
      investigationId: investigation._id,
      projectId: project._id,
      type: 'FINDING',
      text: 'Inclinometer profile confirms displacement concentrated at 8.5m depth shear plane.',
      actorDisplayName: adminUser.displayName,
      createdAt: new Date(Date.now() - 25 * 3600 * 1000)
    });

    await InvestigationNote.create({
      investigationId: investigation._id,
      projectId: project._id,
      type: 'ROOT_CAUSE',
      text: 'Rainfall infiltration accelerated localized pore pressure.',
      actorDisplayName: adminUser.displayName,
      createdAt: new Date(Date.now() - 20 * 3600 * 1000)
    });

    const evtTimes = [
      new Date(Date.now() - 36 * 3600 * 1000),
      new Date(Date.now() - 35 * 3600 * 1000),
      new Date(Date.now() - 30 * 3600 * 1000),
      new Date(Date.now() - 25 * 3600 * 1000),
      new Date(Date.now() - 10 * 3600 * 1000)
    ];

    await InvestigationEvent.create({
      investigationId: investigation._id,
      projectId: project._id,
      eventType: 'CREATED',
      newStatus: 'OPEN',
      comment: 'Investigation opened from canonical alarm',
      actorDisplayName: adminUser.displayName,
      createdAt: evtTimes[0]
    });
    await InvestigationEvent.create({
      investigationId: investigation._id,
      projectId: project._id,
      eventType: 'ASSIGNED',
      previousStatus: 'OPEN',
      newStatus: 'OPEN',
      comment: 'Assigned to Lead Geotechnical Engineer',
      actorDisplayName: adminUser.displayName,
      createdAt: evtTimes[1]
    });
    await InvestigationEvent.create({
      investigationId: investigation._id,
      projectId: project._id,
      eventType: 'STARTED',
      previousStatus: 'OPEN',
      newStatus: 'IN_PROGRESS',
      comment: 'Field survey dispatched',
      actorDisplayName: adminUser.displayName,
      createdAt: evtTimes[2]
    });
    await InvestigationEvent.create({
      investigationId: investigation._id,
      projectId: project._id,
      eventType: 'FINDING_ADDED',
      previousStatus: 'IN_PROGRESS',
      newStatus: 'IN_PROGRESS',
      comment: 'Inclinometer profile confirms displacement concentrated at 8.5m depth',
      actorDisplayName: adminUser.displayName,
      createdAt: evtTimes[3]
    });
    await InvestigationEvent.create({
      investigationId: investigation._id,
      projectId: project._id,
      eventType: 'COMPLETED',
      previousStatus: 'IN_PROGRESS',
      newStatus: 'COMPLETED',
      comment: 'Shear zone movement arrested after remedial works',
      actorDisplayName: adminUser.displayName,
      createdAt: evtTimes[4]
    });
    console.log(`[FIXTURES] Created Investigation INV-2026-0001 (${investigation._id})`);
  }

  console.log('[FIXTURES] Development fixtures successfully ensured.');
  return { project, instrument, device, gateway, canonicalAlarm, investigation };
}

if (process.argv[1]?.endsWith('seed-development-fixtures.js')) {
  mongoose.connect(env.mongoUri)
    .then(() => ensureDevelopmentFixtures())
    .then(() => mongoose.disconnect())
    .catch(err => {
      console.error('[FIXTURES ERROR]', err);
      process.exit(1);
    });
}
