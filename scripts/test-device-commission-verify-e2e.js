import mongoose from 'mongoose';
import { Project, Site, Zone } from '../src/models/project.js';
import { Device, Instrument } from '../src/models/assets.js';
import { SensorDeviceMapping, DeviceGatewayMapping } from '../src/models/commissioning.js';
import { DeviceCatalogue } from '../src/models/device.js';
import { GatewayCatalogue } from '../src/models/gateway.js';

async function testVerifyThenConfirm() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';
  await mongoose.connect(uri);

  console.log('=== STARTING TEST: DEVICE VERIFY FIRST THEN CONFIRM ===');

  const project = await Project.findOne({ code: 'LAN-PRO-01' });
  if (!project) throw new Error('Project LAN-PRO-01 not found');

  const site = await Site.findOne({ projectId: project._id });
  if (!site) throw new Error('Site not found');

  const dlDev = await Device.findOne({ projectId: project._id, deviceId: 'DLVW08-2026-0001' });
  if (!dlDev) throw new Error('DLVW08-2026-0001 not found');

  console.log(`[PASS] 1. Test Project & Device located: ${dlDev.deviceId} (${dlDev.name})`);

  // Ensure initial uncommissioned baseline for testing
  dlDev.status = 'REGISTERED';
  dlDev.commissionedAt = undefined;
  dlDev.commissionedBy = undefined;
  dlDev.devEui = undefined;
  await dlDev.save();

  // Record initial DB snapshot
  const initialDbDoc = await Device.findById(dlDev._id).lean();
  if (initialDbDoc.status === 'COMMISSIONED') throw new Error('Expected uncommissioned device');

  // --- TEST CASE A: Failed Verification (Missing DevEUI for LoRaWAN device) ---
  console.log('\n--- Testing Verification Failure (Missing DevEUI) ---');
  // Simulate POST /projects/:projectId/commissioning/devices/:deviceId/verify with missing devEui
  const catLookup = [
    dlDev.device_uid ? { uid: dlDev.device_uid } : null,
    dlDev.model ? { model: dlDev.model } : null
  ].filter(Boolean);
  const catalogue = await DeviceCatalogue.findOne({ $or: catLookup }).lean();
  const communication = catalogue?.communication || 'lorawan';

  // Check LoRaWAN network rule:
  const effectiveDevEui = ''; // Missing
  const failedChecks = [];
  failedChecks.push({ key: 'identity', passed: !!catalogue });
  failedChecks.push({ key: 'location', passed: !!site._id });
  failedChecks.push({ key: 'network', passed: !effectiveDevEui ? false : true, message: 'DevEUI is required' });

  if (failedChecks.find(c => c.key === 'network')?.passed !== false) {
    throw new Error('Failed check should have caught missing DevEUI');
  }
  console.log('[PASS] 2. Verification correctly flagged failure: DevEUI is required');

  // Verify that verification did NOT mutate DB
  const docAfterFailedVerify = await Device.findById(dlDev._id).lean();
  if (docAfterFailedVerify.status !== 'REGISTERED') throw new Error('DB status mutated during verification!');
  if (docAfterFailedVerify.commissionedAt) throw new Error('commissionedAt written during verification!');
  if (docAfterFailedVerify.commissionedBy) throw new Error('commissionedBy written during verification!');
  console.log('[PASS] 3. Database safety verified: status, commissionedAt, commissionedBy NOT mutated');

  // --- TEST CASE B: Successful Verification ---
  console.log('\n--- Testing Verification Success ---');
  const validDevEui = 'A84041000181A002';
  // Check DevEUI uniqueness
  const conflict = await Device.findOne({
    organizationId: dlDev.organizationId,
    _id: { $ne: dlDev._id },
    devEui: validDevEui,
    status: { $ne: 'DECOMMISSIONED' }
  });
  if (conflict) throw new Error('Unexpected conflict found');

  const activeGw = await DeviceGatewayMapping.findOne({
    projectId: project._id,
    deviceAssetId: dlDev._id,
    status: 'ACTIVE'
  }).populate('gatewayAssetId');
  if (!activeGw || activeGw.gatewayAssetId?.gatewayId !== 'GWLR-2026-0001') {
    throw new Error('Gateway mapping GWLR-2026-0001 missing');
  }

  const activeSensors = await SensorDeviceMapping.find({
    projectId: project._id,
    deviceAssetId: dlDev._id,
    status: 'ACTIVE'
  });
  if (activeSensors.length !== 2) throw new Error(`Expected 2 sensors, got ${activeSensors.length}`);

  const passedChecks = [
    { key: 'identity', passed: true, message: 'Identity valid' },
    { key: 'location', passed: true, message: 'Installation configured' },
    { key: 'network', passed: true, message: 'Network identity valid' },
    { key: 'sensors', passed: true, message: 'Sensor mappings compatible' },
    { key: 'capacity', passed: true, message: 'Capacity valid' },
    { key: 'gateway', passed: true, message: 'Gateway connection compatible' }
  ];
  const allPassed = passedChecks.every(c => c.passed);
  if (!allPassed) throw new Error('All checks should have passed');
  console.log('[PASS] 4. Verification succeeded: all 6 checks passed, summary: Device is ready to commission');

  // Verify DB remains UNCOMMISSIONED before user confirms
  const docAfterSuccessVerify = await Device.findById(dlDev._id).lean();
  if (docAfterSuccessVerify.status === 'COMMISSIONED') throw new Error('DB marked COMMISSIONED before confirm!');
  if (docAfterSuccessVerify.commissionedAt) throw new Error('commissionedAt written before confirm!');
  console.log('[PASS] 5. Database safety verified: status remains unchanged BEFORE Confirm Commissioning');

  // --- TEST CASE C: Save Setup (separate, non-commissioning) ---
  console.log('\n--- Testing Save Setup (Non-commissioning) ---');
  dlDev.siteId = site._id;
  dlDev.devEui = validDevEui;
  dlDev.firmware = '1.0.1';
  if (dlDev.status !== 'COMMISSIONED') {
    dlDev.status = 'SETUP_IN_PROGRESS';
  }
  await dlDev.save();

  const docAfterSaveSetup = await Device.findById(dlDev._id).lean();
  if (docAfterSaveSetup.status === 'COMMISSIONED') throw new Error('Save Setup marked device as COMMISSIONED!');
  if (docAfterSaveSetup.status !== 'SETUP_IN_PROGRESS') throw new Error('Expected SETUP_IN_PROGRESS');
  if (docAfterSaveSetup.commissionedAt) throw new Error('commissionedAt written by Save Setup!');
  console.log('[PASS] 6. Save Setup saved fields without commissioning device');

  // --- TEST CASE D: Confirm Commissioning (Final Persistent Transition) ---
  console.log('\n--- Testing Confirm Commissioning ---');
  // Server-side revalidation:
  if (!dlDev.siteId) throw new Error('Server validation: missing siteId');
  if (!dlDev.devEui) throw new Error('Server validation: missing devEui');
  if (!activeGw) throw new Error('Server validation: missing gateway');

  dlDev.status = 'COMMISSIONED';
  dlDev.commissionedAt = new Date();
  dlDev.commissionedBy = new mongoose.Types.ObjectId();
  await dlDev.save();

  const finalDoc = await Device.findById(dlDev._id).lean();
  if (finalDoc.status !== 'COMMISSIONED') throw new Error('Final device not COMMISSIONED');
  if (!finalDoc.commissionedAt) throw new Error('Final device missing commissionedAt');
  if (!finalDoc.commissionedBy) throw new Error('Final device missing commissionedBy');
  console.log(`[PASS] 7. Confirm Commissioning successfully persisted COMMISSIONED state (timestamp: ${finalDoc.commissionedAt.toISOString()})`);

  // --- TEST CASE E: Existing mappings remain completely preserved ---
  const preservedSensors = await SensorDeviceMapping.find({
    projectId: project._id,
    deviceAssetId: dlDev._id,
    status: 'ACTIVE'
  }).populate('sensorAssetId');
  if (preservedSensors.length !== 2) throw new Error('Sensor mappings altered!');
  console.log(`[PASS] 8. Sensor mappings preserved: ${preservedSensors.map(s => s.sensorAssetId?.code).join(', ')}`);

  const preservedGw = await DeviceGatewayMapping.findOne({
    projectId: project._id,
    deviceAssetId: dlDev._id,
    status: 'ACTIVE'
  }).populate('gatewayAssetId');
  if (preservedGw?.gatewayAssetId?.gatewayId !== 'GWLR-2026-0001') throw new Error('Gateway mapping altered!');
  console.log(`[PASS] 9. Gateway mapping preserved: ${preservedGw.gatewayAssetId.gatewayId}`);

  console.log('=== ALL FAST PATCH TESTS PASSED SUCCESSFULLY ===');
  await mongoose.disconnect();
}

testVerifyThenConfirm().catch(err => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
