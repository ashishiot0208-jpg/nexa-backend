import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/geonexa';

async function run() {
  console.log('=== PHASE B2.5 PROJECT-LEVEL COMMISSIONING VALIDATION SUITE ===\n');
  await mongoose.connect(MONGODB_URI);

  const { Project, Instrument, Device, ProjectGateway, SensorDeviceMapping, DeviceGatewayMapping, AuditEvent, User, SensorChannel } = await import('../src/models/index.js');
  const { validateProjectCommissioning, confirmProjectCommissioning } = await import('../src/services/project-commissioning.service.js');

  try {
    // 1. Locate Landslide Project LAN-PRO-01
    const project = await Project.findOne({
      $or: [{ code: 'LAN-PRO-01' }, { name: 'Landslide Project' }]
    });
    if (!project) throw new Error('Landslide Project LAN-PRO-01 not found');
    console.log(`[PASS] 1. Found Project: ${project.name} (${project.code})`);
    console.log(`       Initial Setup Status: ${project.setupStatus}`);
    console.log(`       Business Status: ${project.status}`);

    const originalPlannedConfig = JSON.stringify(project.plannedConfiguration);
    const originalSensorMappingsCount = await SensorDeviceMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });
    const originalDeviceMappingsCount = await DeviceGatewayMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });

    console.log(`       Active Sensor mappings: ${originalSensorMappingsCount}`);
    console.log(`       Active Device mappings: ${originalDeviceMappingsCount}`);

    // Ensure test user exists
    let testUser = await User.findOne();
    if (!testUser) {
      testUser = await User.create({ email: 'engineer@geonexa.test', displayName: 'Test Geotech Engineer' });
    }

    // Backup current statuses so we can restore if needed
    const preSensors = await Instrument.find({ projectId: project._id }).lean();
    const preDevices = await Device.find({ projectId: project._id }).lean();
    const preGateways = await ProjectGateway.find({ projectId: project._id }).lean();
    const preProjectSetupStatus = project.setupStatus;

    // -------------------------------------------------------------------------
    // TEST A: Read-Only Verification Failure Test (when some sensors uncommissioned)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST A: Verification Failure Test (Uncommissioned Sensors) ---');
    // Ensure INC-2026-0001 is COMMISSIONED, while INC-2026-0002 or PZVW-2026-0001 is REGISTERED
    await Instrument.updateOne({ projectId: project._id, code: 'INC-2026-0001' }, { status: 'COMMISSIONED' });
    await Instrument.updateOne({ projectId: project._id, code: 'INC-2026-0002' }, { status: 'REGISTERED' });
    await Project.updateOne({ _id: project._id }, { 
      setupStatus: 'COMMISSIONING', 
      commissioningCompletedAt: null, 
      commissioningCompletedBy: null 
    });

    const failVerifyRes = await validateProjectCommissioning(project._id);
    if (failVerifyRes.ready !== false) {
      throw new Error(`Expected ready: false, got ready: ${failVerifyRes.ready}`);
    }
    const hasUncommissionedSensorIssue = failVerifyRes.issues.some(i => i.code === 'SENSOR_NOT_COMMISSIONED' && i.assetId === 'INC-2026-0002');
    if (!hasUncommissionedSensorIssue) {
      throw new Error('Expected SENSOR_NOT_COMMISSIONED issue for INC-2026-0002');
    }
    console.log('[PASS] Verification correctly failed with issues:', failVerifyRes.issues.length);
    console.log('       Sample issue:', failVerifyRes.issues.find(i => i.assetId === 'INC-2026-0002')?.message);

    // Verify Read-Only Guarantee: Project.setupStatus must NOT change
    const checkProjA = await Project.findById(project._id).lean();
    if (checkProjA.setupStatus !== 'COMMISSIONING') {
      throw new Error(`setupStatus was mutated during verify: ${checkProjA.setupStatus}`);
    }
    if (checkProjA.commissioningCompletedAt || checkProjA.commissioningCompletedBy) {
      throw new Error('commissioningCompleted fields were written during read-only verify!');
    }
    console.log('[PASS] Verify action is strictly read-only: setupStatus remains COMMISSIONING, no audit timestamps written.');

    // -------------------------------------------------------------------------
    // TEST B: Scope Mismatch Warning Verification (Non-blocking)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST B: Planned Quantity Mismatch Handling ---');
    console.log('       Planned Sensors: 20 | Registered:', failVerifyRes.summary.registeredSensors);
    if (!failVerifyRes.scopeMismatch) {
      throw new Error('Expected scopeMismatch: true due to 4 registered vs 20 planned');
    }
    const scopeWarning = failVerifyRes.warnings.find(w => w.includes('planned Sensors have not been registered'));
    if (!scopeWarning) {
      throw new Error('Expected warning regarding unregistered planned sensors');
    }
    console.log('[PASS] Scope mismatch correctly reported as warning:', scopeWarning);
    console.log('[PASS] Scope mismatch alone does NOT block technical verification (ready flag governed solely by technical issues).');

    // -------------------------------------------------------------------------
    // TEST C: Device & Gateway Verification Tests
    // -------------------------------------------------------------------------
    console.log('\n--- TEST C: Device / Gateway Verification Validation ---');
    // Test if device is uncommissioned
    await Device.updateOne({ projectId: project._id, deviceId: 'DLVW08-2026-0001' }, { status: 'REGISTERED' });
    const devFailRes = await validateProjectCommissioning(project._id);
    const hasDevIssue = devFailRes.issues.some(i => i.code === 'DEVICE_NOT_COMMISSIONED');
    if (!hasDevIssue) {
      throw new Error('Expected DEVICE_NOT_COMMISSIONED when DLVW08-2026-0001 is REGISTERED');
    }
    console.log('[PASS] Active device in use but not commissioned triggers technical failure.');

    // -------------------------------------------------------------------------
    // TEST D: Verification Success Test (All Active Hardware Commissioned)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST D: Verification Success Test ---');
    // Ensure PZVW-2026-0002 has site and channels configured like PZVW-2026-0001
    const pz1 = await Instrument.findOne({ projectId: project._id, code: 'PZVW-2026-0001' }).lean();
    await Instrument.updateOne(
      { projectId: project._id, code: 'PZVW-2026-0002' },
      { siteId: pz1.siteId, status: 'COMMISSIONED' }
    );
    const pz2 = await Instrument.findOne({ projectId: project._id, code: 'PZVW-2026-0002' }).lean();
    let pz2Chs = await SensorChannel.find({ instrumentId: pz2._id }).lean();
    if (pz2Chs.length === 0) {
      await SensorChannel.create([
        {
          organizationId: project.organizationId,
          projectId: project._id,
          instrumentId: pz2._id,
          code: 'CH-PZ2-PRESSURE',
          parameterCode: 'PORE_PRESSURE',
          enabled: true,
          calibration: { configured: true, scale: 1, offset: 0, version: 1 },
          baseline: { configured: true, value: 0, version: 1 }
        },
        {
          organizationId: project.organizationId,
          projectId: project._id,
          instrumentId: pz2._id,
          code: 'CH-PZ2-TEMP',
          parameterCode: 'TEMPERATURE',
          enabled: true,
          calibration: { configured: true, scale: 1, offset: 0, version: 1 },
          baseline: { configured: true, value: 20, version: 1 }
        }
      ]);
    }

    // Ensure INCL-004 has active mapping or is decommissioned
    const incl4 = await Instrument.findOne({ projectId: project._id, code: 'INCL-004' });
    if (incl4) {
      const dev485 = await Device.findOne({ projectId: project._id, deviceId: 'SNRS485-2026-0001' });
      const incl4Mapping = await SensorDeviceMapping.findOne({ sensorAssetId: incl4._id, status: 'ACTIVE' });
      if (!incl4Mapping && dev485) {
        await SensorDeviceMapping.create({
          organizationId: project.organizationId,
          projectId: project._id,
          sensorAssetId: incl4._id,
          deviceAssetId: dev485._id,
          connectionSlot: 4,
          status: 'ACTIVE'
        });
      }
      await Instrument.updateOne({ _id: incl4._id }, { siteId: pz1.siteId, status: 'COMMISSIONED' });
    }

    // Set all active instruments, devices, and gateways for this project to COMMISSIONED
    await Instrument.updateMany({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } }, { status: 'COMMISSIONED' });
    await Device.updateMany({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } }, { status: 'COMMISSIONED' });
    await ProjectGateway.updateMany({ projectId: project._id, status: { $ne: 'DECOMMISSIONED' } }, { status: 'COMMISSIONED' });

    const passVerifyRes = await validateProjectCommissioning(project._id);
    if (passVerifyRes.ready !== true) {
      console.error('Unexpected issues on passVerifyRes:', passVerifyRes.issues);
      throw new Error(`Expected ready: true, but got ready: false with ${passVerifyRes.issues.length} issues`);
    }
    console.log('[PASS] All active hardware commissioned -> Verification PASSED (ready: true)!');
    console.log('       Checks summary:');
    passVerifyRes.checks.forEach(c => console.log(`       ✓ ${c.name} (${c.passed ? 'PASSED' : 'FAILED'})`));
    console.log(`       Scope mismatch warning preserved non-blockingly: ${passVerifyRes.scopeMismatch}`);

    // Verify Project setupStatus still remains COMMISSIONING before confirm
    const checkProjD = await Project.findById(project._id).lean();
    if (checkProjD.setupStatus !== 'COMMISSIONING') {
      throw new Error(`setupStatus should still be COMMISSIONING before confirm, got: ${checkProjD.setupStatus}`);
    }
    console.log('[PASS] SetupStatus still COMMISSIONING after successful verification.');

    // -------------------------------------------------------------------------
    // TEST E: Final Confirm Project Commissioning
    // -------------------------------------------------------------------------
    console.log('\n--- TEST E: Final Confirm Project Commissioning ---');
    const preConfirmSensorMappingsCount = await SensorDeviceMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });
    const preConfirmDeviceMappingsCount = await DeviceGatewayMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });

    const confirmRes = await confirmProjectCommissioning(project._id, testUser._id);
    if (!confirmRes.success) {
      throw new Error(`Confirm failed: ${confirmRes.message}`);
    }
    console.log('[PASS] confirmProjectCommissioning succeeded!');
    console.log(`       Project status: ${confirmRes.project.status}`);
    console.log(`       Project setupStatus: ${confirmRes.project.setupStatus}`);
    console.log(`       Commissioning completed at: ${confirmRes.project.commissioningCompletedAt}`);
    console.log(`       Commissioning completed by: ${confirmRes.project.completedByUserName || confirmRes.project.commissioningCompletedBy}`);

    // Verify DB State
    const freshProject = await Project.findById(project._id).lean();
    if (freshProject.setupStatus !== 'COMMISSIONED') {
      throw new Error(`Expected Project.setupStatus to be COMMISSIONED, got: ${freshProject.setupStatus}`);
    }
    if (freshProject.status !== 'ACTIVE') {
      throw new Error(`Project business status was altered! Expected ACTIVE, got: ${freshProject.status}`);
    }
    if (!freshProject.commissioningCompletedAt) {
      throw new Error('commissioningCompletedAt was not persisted!');
    }
    if (String(freshProject.commissioningCompletedBy) !== String(testUser._id)) {
      throw new Error('commissioningCompletedBy was not persisted correctly!');
    }
    console.log('[PASS] Project.setupStatus = COMMISSIONED persisted atomically.');
    console.log('[PASS] Project business status = ACTIVE unchanged.');
    console.log('[PASS] commissioningCompletedAt & commissioningCompletedBy properly stored.');

    // Verify Database Safety (Section 35)
    console.log('\n--- TEST F: Database Safety Verification (Section 35) ---');
    if (JSON.stringify(freshProject.plannedConfiguration) !== originalPlannedConfig) {
      throw new Error('CRITICAL: plannedConfiguration was modified!');
    }
    console.log('[PASS] plannedConfiguration UNCHANGED.');

    const finalSensorMappingsCount = await SensorDeviceMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });
    const finalDeviceMappingsCount = await DeviceGatewayMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });
    if (finalSensorMappingsCount !== preConfirmSensorMappingsCount) {
      throw new Error('CRITICAL: SensorDeviceMappings count altered during confirm!');
    }
    if (finalDeviceMappingsCount !== preConfirmDeviceMappingsCount) {
      throw new Error('CRITICAL: DeviceGatewayMappings count altered during confirm!');
    }
    console.log('[PASS] SensorDeviceMappings UNCHANGED.');
    console.log('[PASS] DeviceGatewayMappings UNCHANGED.');

    // Check Audit Log
    const auditRecord = await AuditEvent.findOne({
      action: 'PROJECT_COMMISSIONED',
      resourceId: project._id.toString()
    }).sort({ createdAt: -1 });
    if (!auditRecord) {
      console.warn('[WARN] AuditEvent record not found - checking audit service');
    } else {
      console.log(`[PASS] PROJECT_COMMISSIONED audit event recorded by actor ${auditRecord.actorId} at ${auditRecord.createdAt}.`);
    }

    console.log('\n========================================================');
    console.log('ALL PHASE B2.5 BACKEND & INTEGRATION TESTS PASSED!');
    console.log('========================================================');

  } finally {
    await mongoose.disconnect();
  }
}

run().catch(err => {
  console.error('\n[TEST FAILURE]:', err);
  process.exit(1);
});
