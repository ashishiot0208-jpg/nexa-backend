import { connectDb, disconnectDb } from './src/config/db.js';
import { Project, Device, Instrument, ProjectGateway, SensorDeviceMapping, DeviceGatewayMapping } from './src/models/index.js';
import { validateProjectCommissioning, confirmProjectCommissioning } from './src/services/project-commissioning.service.js';

async function runTests() {
  await connectDb();
  console.log('=== STARTING COMMISSIONING VALIDATION ACCEPTANCE TESTS ===\n');

  const project = await Project.findOne({ code: 'LAN-PRO-01' });
  if (!project) throw new Error('LAN-PRO-01 not found');

  // Verify baseline
  const instCount = await Instrument.countDocuments({ projectId: project._id, status: 'COMMISSIONED' });
  const gwCount = await ProjectGateway.countDocuments({ projectId: project._id, status: 'COMMISSIONED' });
  const smCount = await SensorDeviceMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });
  const dmCount = await DeviceGatewayMapping.countDocuments({ projectId: project._id, status: 'ACTIVE' });
  console.log(`Baseline: Sensors commissioned: ${instCount}, Gateways commissioned: ${gwCount}`);
  console.log(`          Sensor->Device: ${smCount}, Device->Gateway: ${dmCount}\n`);

  // -------------------------------------------------------------
  // TEST 16: CURRENT BAD STATE (0 DEVICES COMMISSIONED)
  // -------------------------------------------------------------
  console.log('--- TEST 16: Bad State (0 devices commissioned) ---');
  await Device.updateMany(
    { projectId: project._id },
    { $set: { commissioningStatus: 'REGISTERED', status: 'OFFLINE' }, $unset: { commissionedAt: 1, commissionedBy: 1 } }
  );
  await Project.updateOne({ _id: project._id }, { $set: { setupStatus: 'COMMISSIONING' }, $unset: { commissioningCompletedAt: 1, commissioningCompletedBy: 1 } });

  const res16 = await validateProjectCommissioning(project._id);
  console.log('Verification ready:', res16.ready);
  console.log('Summary commissioned devices:', res16.summary.commissionedDevices);
  console.log('Issues found:', res16.issues.map(i => `${i.assetId}: ${i.code} (${i.message})`));

  if (res16.ready !== false) throw new Error('TEST 16 FAILED: Verification should have failed!');
  const devIssues16 = res16.issues.filter(i => i.code === 'DEVICE_NOT_COMMISSIONED');
  if (devIssues16.length !== 2) throw new Error(`TEST 16 FAILED: Expected 2 DEVICE_NOT_COMMISSIONED issues, got ${devIssues16.length}`);
  console.log('Check devices_commissioned passed:', res16.checks.find(c => c.key === 'devices_commissioned')?.passed);
  console.log('Check message:', res16.checks.find(c => c.key === 'devices_commissioned')?.message);

  // Test confirm safety: calling confirm must fail
  let confirmFailedAsExpected = false;
  try {
    await confirmProjectCommissioning(project._id, '6ac4c517fb791da169ce9a3d');
  } catch (err) {
    confirmFailedAsExpected = true;
    console.log('Confirm rejection message (server safety):', err.message);
  }
  if (!confirmFailedAsExpected) throw new Error('TEST 16 FAILED: confirmProjectCommissioning should have been rejected!');
  console.log('TEST 16 PASSED ✓\n');

  // -------------------------------------------------------------
  // TEST 17: ONE DEVICE COMMISSIONED (SNRS485-2026-0001 ONLY)
  // -------------------------------------------------------------
  console.log('--- TEST 17: Only SNRS485-2026-0001 commissioned ---');
  await Device.updateOne(
    { projectId: project._id, deviceId: 'SNRS485-2026-0001' },
    { $set: { commissioningStatus: 'COMMISSIONED', status: 'COMMISSIONED', commissionedAt: new Date() } }
  );
  await Device.updateOne(
    { projectId: project._id, deviceId: 'DLVW08-2026-0001' },
    { $set: { commissioningStatus: 'REGISTERED', status: 'OFFLINE' }, $unset: { commissionedAt: 1, commissionedBy: 1 } }
  );

  const res17 = await validateProjectCommissioning(project._id);
  console.log('Verification ready:', res17.ready);
  console.log('Summary commissioned devices:', res17.summary.commissionedDevices);
  console.log('Issues found:', res17.issues.map(i => `${i.assetId}: ${i.code} (${i.message})`));

  if (res17.ready !== false) throw new Error('TEST 17 FAILED: Verification should have failed!');
  const devIssues17 = res17.issues.filter(i => i.code === 'DEVICE_NOT_COMMISSIONED');
  if (devIssues17.length !== 1 || devIssues17[0].assetId !== 'DLVW08-2026-0001') {
    throw new Error(`TEST 17 FAILED: Expected only DLVW08-2026-0001 to fail, got ${JSON.stringify(devIssues17)}`);
  }
  console.log('Check devices_commissioned passed:', res17.checks.find(c => c.key === 'devices_commissioned')?.passed);
  console.log('Check message:', res17.checks.find(c => c.key === 'devices_commissioned')?.message);
  console.log('TEST 17 PASSED ✓\n');

  // -------------------------------------------------------------
  // TEST 18: BOTH DEVICES COMMISSIONED
  // -------------------------------------------------------------
  console.log('--- TEST 18: Both devices commissioned ---');
  await Device.updateOne(
    { projectId: project._id, deviceId: 'DLVW08-2026-0001' },
    { $set: { commissioningStatus: 'COMMISSIONED', status: 'COMMISSIONED', commissionedAt: new Date() } }
  );

  const res18 = await validateProjectCommissioning(project._id);
  console.log('Verification ready:', res18.ready);
  console.log('Summary commissioned devices:', res18.summary.commissionedDevices);
  console.log('Technical issues count:', res18.issues.length);

  if (res18.ready !== true) throw new Error(`TEST 18 FAILED: Expected verification to pass, but had issues: ${JSON.stringify(res18.issues)}`);
  console.log('Check devices_commissioned passed:', res18.checks.find(c => c.key === 'devices_commissioned')?.passed);
  console.log('Check message:', res18.checks.find(c => c.key === 'devices_commissioned')?.message);

  // Confirm project commissioning
  const confirmRes = await confirmProjectCommissioning(project._id, '6ac4c517fb791da169ce9a3d');
  console.log('Confirm result success:', confirmRes.success);
  console.log('Project setupStatus:', confirmRes.project.setupStatus);
  console.log('Project commissionedAt:', confirmRes.project.commissioningCompletedAt);

  const updatedProject = await Project.findById(project._id).lean();
  if (updatedProject.setupStatus !== 'COMMISSIONED') {
    throw new Error('TEST 18 FAILED: Project setupStatus was not set to COMMISSIONED!');
  }
  console.log('TEST 18 PASSED ✓\n');

  // -------------------------------------------------------------
  // AUTO-REPAIR TEST: If project is marked COMMISSIONED but devices are reset to uncommissioned
  // -------------------------------------------------------------
  console.log('--- AUTO-REPAIR TEST ---');
  // Device DLVW08-2026-0001 reset to REGISTERED while Project is COMMISSIONED
  await Device.updateOne(
    { projectId: project._id, deviceId: 'DLVW08-2026-0001' },
    { $set: { commissioningStatus: 'REGISTERED', status: 'OFFLINE' }, $unset: { commissionedAt: 1, commissionedBy: 1 } }
  );
  // Re-run validation
  const autoRepairRes = await validateProjectCommissioning(project._id);
  console.log('Verification ready:', autoRepairRes.ready);
  const repairedProject = await Project.findById(project._id).lean();
  console.log('Repaired Project setupStatus:', repairedProject.setupStatus);
  console.log('Repaired Project commissioningCompletedAt:', repairedProject.commissioningCompletedAt);
  if (repairedProject.setupStatus !== 'COMMISSIONING') {
    throw new Error('AUTO-REPAIR FAILED: Project was not downgraded to COMMISSIONING!');
  }
  if (repairedProject.commissioningCompletedAt != null) {
    throw new Error('AUTO-REPAIR FAILED: commissioningCompletedAt was not unset!');
  }
  console.log('AUTO-REPAIR PASSED ✓\n');

  // Finally reset to clean Acceptance Test 16 state for evaluation
  await Device.updateMany(
    { projectId: project._id },
    { $set: { commissioningStatus: 'REGISTERED', status: 'OFFLINE' }, $unset: { commissionedAt: 1, commissionedBy: 1 } }
  );
  await Project.updateOne(
    { _id: project._id },
    { $set: { setupStatus: 'COMMISSIONING' }, $unset: { commissioningCompletedAt: 1, commissioningCompletedBy: 1 } }
  );

  console.log('=== ALL TESTS PASSED SUCCESSFULLY ===');
  await disconnectDb();
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
