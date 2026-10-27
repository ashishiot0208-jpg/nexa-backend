/**
 * Safe repair script for Project Commissioning state
 * Specifically targets LAN-PRO-01 (or specified project code).
 *
 * Rules:
 * - Does NOT modify plannedConfiguration
 * - Does NOT modify SensorDeviceMappings
 * - Does NOT modify DeviceGatewayMappings
 * - Does NOT modify Sensor setups or Gateway setups
 * - Only resets in-use devices to uncommissioned state (REGISTERED) for Acceptance Test 16 baseline
 * - Downgrades Project.setupStatus to COMMISSIONING
 * - Unsets project-level completion fields
 */
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Project, Device } from '../src/models/index.js';

async function run() {
  const projectCode = process.argv[2] || 'LAN-PRO-01';
  console.log(`[repair] Connecting to database for project: ${projectCode}...`);
  await connectDb();

  const project = await Project.findOne({ code: projectCode });
  if (!project) {
    console.error(`[repair] Project '${projectCode}' not found.`);
    await disconnectDb();
    process.exit(1);
  }

  console.log(`[repair] Found Project '${project.name}' (${project.code}):`);
  console.log(`         Current setupStatus: ${project.setupStatus}`);
  console.log(`         commissioningCompletedAt: ${project.commissioningCompletedAt}`);
  console.log(`         commissioningCompletedBy: ${project.commissioningCompletedBy}`);

  // 1. Reset in-use devices for this project to REGISTERED
  const devUpdate = await Device.updateMany(
    { projectId: project._id, deviceId: { $in: ['SNRS485-2026-0001', 'DLVW08-2026-0001'] } },
    {
      $set: {
        commissioningStatus: 'REGISTERED',
        status: 'OFFLINE'
      },
      $unset: {
        commissionedAt: 1,
        commissionedBy: 1
      }
    }
  );
  console.log(`[repair] Reset ${devUpdate.modifiedCount} in-use device(s) to commissioningStatus: 'REGISTERED'`);

  // 2. Safe repair project setupStatus -> COMMISSIONING
  project.setupStatus = 'COMMISSIONING';
  project.commissioningCompletedAt = undefined;
  project.commissioningCompletedBy = undefined;
  await project.save();
  console.log(`[repair] Updated Project setupStatus -> 'COMMISSIONING', cleared completed timestamps`);

  const updatedDevs = await Device.find({ projectId: project._id }).lean();
  console.log('[repair] Current Device states:');
  for (const d of updatedDevs) {
    console.log(`         - ${d.deviceId}: commissioningStatus=${d.commissioningStatus || 'REGISTERED'}, runtimeStatus=${d.runtimeStatus || d.status}, commissionedAt=${d.commissionedAt}`);
  }

  console.log('[repair] Project repair completed successfully.');
  await disconnectDb();
}

run().catch(err => {
  console.error('[repair] Error:', err);
  process.exit(1);
});
