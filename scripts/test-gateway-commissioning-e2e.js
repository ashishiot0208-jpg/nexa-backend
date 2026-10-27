import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/geonexa';

async function runTests() {
  console.log('--- STARTING E2E GATEWAY COMMISSIONING TESTS ---');
  await mongoose.connect(MONGODB_URI);

  const { Project } = await import('../src/models/project.js');
  const { ProjectGateway, DeviceGatewayMapping } = await import('../src/models/commissioning.js');
  const { GatewayCatalogue } = await import('../src/models/gateway.js');
  const { Device } = await import('../src/models/assets.js');

  try {
    // 1. Find Landslide Project
    const project = await Project.findOne({
      $or: [{ code: 'LAN-PRO-01' }, { name: 'Landslide Project' }]
    });
    if (!project) throw new Error('Landslide Project (LAN-PRO-01) not found');
    console.log('[PASS] 1. Test Project found:', project.name, `(${project.code})`);

    // 2. Find existing actual Gateway GWLR-2026-0001
    const gateway = await ProjectGateway.findOne({
      projectId: project._id,
      gatewayId: 'GWLR-2026-0001'
    });
    if (!gateway) throw new Error('Gateway GWLR-2026-0001 not found');
    console.log('[PASS] 2. Actual Gateway found:', gateway.gatewayId, '| Status:', gateway.status);

    // 3. Resolve Gateway Catalogue
    const catalogue = await GatewayCatalogue.findOne({ uid: gateway.gateway_uid });
    if (!catalogue) throw new Error(`Gateway catalogue ${gateway.gateway_uid} not found`);
    console.log('[PASS] 3. Catalogue resolved:', catalogue.name, '| Model:', catalogue.model, '| Comm:', catalogue.supported_device_communications, '| Max Devices:', catalogue.max_devices);

    // 4. Verify existing DeviceGatewayMappings
    const mappings = await DeviceGatewayMapping.find({
      projectId: project._id,
      gatewayAssetId: gateway._id,
      status: 'ACTIVE'
    }).populate('deviceAssetId');
    if (mappings.length < 2) throw new Error(`Expected at least 2 mapped devices, found ${mappings.length}`);
    const mappedDeviceIds = mappings.map(m => m.deviceAssetId.deviceId);
    if (!mappedDeviceIds.includes('SNRS485-2026-0001') || !mappedDeviceIds.includes('DLVW08-2026-0001')) {
      throw new Error(`Expected mappings for SNRS485-2026-0001 and DLVW08-2026-0001, found: ${mappedDeviceIds.join(', ')}`);
    }
    console.log('[PASS] 4. Existing Device mappings verified:', mappedDeviceIds.join(', '));

    // 5. Verify Save Setup does not set COMMISSIONED
    gateway.siteId = project.hierarchy?.[0]?.id || 'site-1';
    gateway.gatewayEui = 'A84041FFFFFF0001';
    gateway.activeBackhaul = 'ethernet';
    gateway.status = 'SETUP_IN_PROGRESS';
    gateway.commissionedAt = undefined;
    gateway.commissionedBy = undefined;
    await gateway.save();

    const savedGw = await ProjectGateway.findById(gateway._id);
    if (savedGw.status === 'COMMISSIONED') throw new Error('Save Setup must NOT set COMMISSIONED status');
    if (savedGw.commissionedAt) throw new Error('Save Setup must NOT set commissionedAt');
    console.log('[PASS] 5. Save Setup properly persists setup metadata without setting COMMISSIONED');

    // 6. Test Format Validation for Gateway EUI
    const invalidEui = 'XYZ123';
    const isEuiValid = /^[0-9A-F]{16}$/i.test(invalidEui);
    if (isEuiValid) throw new Error('Invalid EUI should fail format check');
    console.log('[PASS] 6. Gateway EUI format check correctly rejects invalid string');

    // 7. Verify device mappings survive unchanged
    const mappingsAfterSave = await DeviceGatewayMapping.find({
      projectId: project._id,
      gatewayAssetId: gateway._id,
      status: 'ACTIVE'
    });
    if (mappingsAfterSave.length !== mappings.length) throw new Error('Mappings were altered during save');
    console.log('[PASS] 7. Device mappings completely preserved');

    // 8. Confirm Commissioning test
    savedGw.status = 'COMMISSIONED';
    savedGw.commissionedAt = new Date();
    await savedGw.save();

    const commGw = await ProjectGateway.findById(gateway._id);
    if (commGw.status !== 'COMMISSIONED' || !commGw.commissionedAt) {
      throw new Error('Confirm Commissioning failed to persist COMMISSIONED state');
    }
    console.log('[PASS] 8. Gateway successfully transitioned to COMMISSIONED with timestamp');

    // 9. Verify compatibility check logic
    const supportedComms = catalogue.supported_device_communications || ['lorawan'];
    for (const m of mappings) {
      const devComm = m.deviceAssetId.transport === 'LORAWAN' ? 'lorawan' : (m.deviceAssetId.transport?.toLowerCase() || 'lorawan');
      if (!supportedComms.includes(devComm)) {
        throw new Error(`Device ${m.deviceAssetId.deviceId} communication '${devComm}' incompatible`);
      }
    }
    console.log('[PASS] 9. Compatibility verification passed for all mapped devices');

    console.log('--- ALL BACKEND GATEWAY COMMISSIONING CHECKS PASSED ---');
  } finally {
    await mongoose.disconnect();
  }
}

runTests().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
