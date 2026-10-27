import mongoose from 'mongoose';
import { 
  Project, Instrument, Device, ProjectGateway, 
  SensorDeviceMapping, DeviceGatewayMapping, 
  Sensor, DeviceCatalogue, GatewayCatalogue, 
  SensorChannel, User
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from './audit.service.js';

/**
 * Resolves a Project by ObjectId or project code.
 */
export async function resolveProject(projectId) {
  if (!projectId) throw new ApiError(400, 'Project ID is required');
  const query = mongoose.Types.ObjectId.isValid(projectId)
    ? { _id: projectId }
    : { code: String(projectId).toUpperCase() };
  const project = await Project.findOne(query);
  if (!project) throw new ApiError(404, 'Project not found');
  return project;
}

/**
 * Returns the Device Commissioning lifecycle status (not runtime connectivity).
 */
export function getDeviceCommissioningStatus(dev) {
  if (dev.commissioningStatus) {
    return dev.commissioningStatus;
  }
  if (['REGISTERED', 'SETUP_IN_PROGRESS', 'COMMISSIONED', 'DECOMMISSIONED'].includes(dev.status)) {
    return dev.status;
  }
  return 'REGISTERED';
}

/**
 * Determines whether a device has completed commissioning lifecycle.
 */
export function isDeviceCommissioned(dev) {
  return dev.commissioningStatus === 'COMMISSIONED' || 
    (!dev.commissioningStatus && dev.status === 'COMMISSIONED');
}

/**
 * Core Project Commissioning Validator
 * Evaluates Project readiness for operational monitoring.
 * Read-only: does NOT mutate project, assets, mappings, or plannedConfiguration.
 */
export async function validateProjectCommissioning(projectIdParam) {
  const project = await resolveProject(projectIdParam);
  const projectId = project._id;

  const planned = project.plannedConfiguration || { sensors: [], devices: [], gateways: [] };
  const plannedSensors = (planned.sensors || []).reduce((sum, s) => sum + (s.quantity || 0), 0);
  const plannedDevices = (planned.devices || []).reduce((sum, d) => sum + (d.quantity || 0), 0);
  const plannedGateways = (planned.gateways || []).reduce((sum, g) => sum + (g.quantity || 0), 0);

  // 1. Fetch all actual active registered assets (non-decommissioned)
  const [instruments, devices, gateways] = await Promise.all([
    Instrument.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    Device.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).lean(),
    ProjectGateway.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).lean()
  ]);

  // 2. Fetch all active mappings
  const [sensorMappings, deviceMappings] = await Promise.all([
    SensorDeviceMapping.find({ projectId, status: 'ACTIVE' }).lean(),
    DeviceGatewayMapping.find({ projectId, status: 'ACTIVE' }).lean()
  ]);

  // 3. Fetch catalogues for instruments, devices, and gateways
  const sensorUids = [...new Set(instruments.map(i => i.sensor_uid || i.catalogCode).filter(Boolean))];
  const deviceUids = [...new Set(devices.map(d => d.device_uid || d.metadata?.device_uid).filter(Boolean))];
  const gatewayUids = [...new Set(gateways.map(g => g.gateway_uid || g.metadata?.gateway_uid).filter(Boolean))];

  const [sensorCatalogues, deviceCatalogues, gatewayCatalogues, sensorChannels] = await Promise.all([
    Sensor.find({ uid: { $in: sensorUids } }).lean(),
    DeviceCatalogue.find({ uid: { $in: deviceUids } }).lean(),
    GatewayCatalogue.find({ uid: { $in: gatewayUids } }).lean(),
    SensorChannel.find({ projectId }).lean()
  ]);

  const sensorCatMap = new Map(sensorCatalogues.map(c => [c.uid, c]));
  const deviceCatMap = new Map(deviceCatalogues.map(c => [c.uid, c]));
  const gatewayCatMap = new Map(gatewayCatalogues.map(c => [c.uid, c]));

  // Index channels by instrumentId
  const channelsByInst = new Map();
  for (const ch of sensorChannels) {
    const instId = ch.instrumentId?.toString();
    if (!channelsByInst.has(instId)) {
      channelsByInst.set(instId, []);
    }
    channelsByInst.get(instId).push(ch);
  }

  // Derive counts
  const registeredSensors = instruments.length;
  const registeredDevices = devices.length;
  const registeredGateways = gateways.length;

  const commissionedSensors = instruments.filter(i => i.status === 'COMMISSIONED').length;
  const commissionedDevices = devices.filter(d => isDeviceCommissioned(d)).length;
  const commissionedGateways = gateways.filter(g => g.status === 'COMMISSIONED').length;

  const issues = [];
  const warnings = [];
  const assetStatuses = {
    sensors: [],
    devices: [],
    gateways: [],
    mappings: []
  };

  // Helper maps for fast lookups
  const instMap = new Map(instruments.map(i => [i._id.toString(), i]));
  const devMap = new Map(devices.map(d => [d._id.toString(), d]));
  const gwMap = new Map(gateways.map(g => [g._id.toString(), g]));

  // ----------------------------------------------------
  // A. VALIDATE ACTUAL SENSOR STATE
  // ----------------------------------------------------
  if (instruments.length === 0) {
    issues.push({
      type: 'SENSOR',
      assetType: 'Sensor',
      assetId: 'NONE',
      code: 'NO_ACTIVE_SENSORS',
      message: 'No active sensors have been registered in this project'
    });
  }

  for (const inst of instruments) {
    const instIdStr = inst._id.toString();
    const instCat = sensorCatMap.get(inst.sensor_uid || inst.catalogCode);
    const instChannels = channelsByInst.get(instIdStr) || [];
    const activeMapping = sensorMappings.find(m => m.sensorAssetId.toString() === instIdStr);

    let sensorPassed = true;
    const sensorProblems = [];

    // Check status === 'COMMISSIONED'
    if (inst.status !== 'COMMISSIONED') {
      sensorPassed = false;
      sensorProblems.push('Sensor not commissioned');
      issues.push({
        type: 'SENSOR',
        assetType: 'Sensor',
        assetId: inst.code,
        code: 'SENSOR_NOT_COMMISSIONED',
        message: `${inst.code} Sensor not commissioned`
      });
    } else {
      // If COMMISSIONED, verify setup completeness
      if (!inst.siteId) {
        sensorPassed = false;
        sensorProblems.push('site not selected');
        issues.push({
          type: 'SENSOR',
          assetType: 'Sensor',
          assetId: inst.code,
          code: 'SENSOR_SITE_MISSING',
          message: `${inst.code} site/structure not selected`
        });
      }

      const enabledChannels = instChannels.filter(c => c.enabled !== false);
      if (instChannels.length > 0 && enabledChannels.length === 0) {
        sensorPassed = false;
        sensorProblems.push('no enabled measurement channels');
        issues.push({
          type: 'SENSOR',
          assetType: 'Sensor',
          assetId: inst.code,
          code: 'SENSOR_NO_CHANNELS',
          message: `${inst.code} has no enabled measurement channels`
        });
      }

      const isCalibDone = inst.metadata?.calibrationConfigured === true ||
        (instChannels.length > 0 && instChannels.every(c => c.calibration?.configured || c.calibration?.scale != null));
      if (!isCalibDone) {
        sensorPassed = false;
        sensorProblems.push('calibration incomplete');
        issues.push({
          type: 'SENSOR',
          assetType: 'Sensor',
          assetId: inst.code,
          code: 'SENSOR_CALIBRATION_INCOMPLETE',
          message: `${inst.code} calibration incomplete`
        });
      }

      const isBaselineDone = inst.metadata?.baselineConfigured === true ||
        (instChannels.length > 0 && instChannels.every(c => c.baseline?.configured || c.baseline?.value != null));
      if (!isBaselineDone) {
        sensorPassed = false;
        sensorProblems.push('baseline incomplete');
        issues.push({
          type: 'SENSOR',
          assetType: 'Sensor',
          assetId: inst.code,
          code: 'SENSOR_BASELINE_INCOMPLETE',
          message: `${inst.code} baseline incomplete`
        });
      }

      if (!activeMapping) {
        sensorPassed = false;
        sensorProblems.push('not mapped to a device');
        issues.push({
          type: 'SENSOR',
          assetType: 'Sensor',
          assetId: inst.code,
          code: 'SENSOR_NOT_MAPPED',
          message: `${inst.code} not mapped to an active device`
        });
      }
    }

    assetStatuses.sensors.push({
      id: inst._id,
      code: inst.code,
      name: inst.name,
      status: inst.status,
      passed: sensorPassed,
      message: sensorPassed ? `${inst.code} commissioned` : `${inst.code} ${sensorProblems.join(', ')}`
    });
  }

  // ----------------------------------------------------
  // B. VALIDATE ACTUAL DEVICE STATE
  // ----------------------------------------------------
  if (devices.length === 0 && instruments.length > 0) {
    issues.push({
      type: 'DEVICE',
      assetType: 'Device',
      assetId: 'NONE',
      code: 'NO_ACTIVE_DEVICES',
      message: 'No active devices registered in this project'
    });
  }

  // Identify in-use devices: Device is in use if it has at least one ACTIVE SensorDeviceMapping from an active Sensor
  const activeSensorIdSet = new Set(instruments.map(i => i._id.toString()));
  const inUseDeviceIdSet = new Set();
  const deviceSensorCountMap = new Map();

  for (const sm of sensorMappings) {
    const sId = sm.sensorAssetId.toString();
    const devId = sm.deviceAssetId.toString();
    if (activeSensorIdSet.has(sId)) {
      inUseDeviceIdSet.add(devId);
      deviceSensorCountMap.set(devId, (deviceSensorCountMap.get(devId) || 0) + 1);
    }
  }

  for (const dev of devices) {
    const devIdStr = dev._id.toString();
    const isInUse = inUseDeviceIdSet.has(devIdStr);
    const cat = deviceCatMap.get(dev.device_uid || dev.metadata?.device_uid);
    const connectedCount = deviceSensorCountMap.get(devIdStr) || 0;
    const maxChannels = cat?.max_channels || dev.metadata?.max_channels || 8;
    const commissioned = isDeviceCommissioned(dev);

    let devPassed = true;
    const devProblems = [];

    // In-use devices MUST be COMMISSIONED
    if (isInUse) {
      if (!commissioned) {
        devPassed = false;
        devProblems.push('not commissioned');
        issues.push({
          type: 'DEVICE_NOT_COMMISSIONED',
          assetType: 'DEVICE',
          assetId: dev.deviceId,
          code: 'DEVICE_NOT_COMMISSIONED',
          message: `${dev.deviceId} Device is in use but has not been commissioned.`
        });
      }

      if (!cat && !dev.name) {
        devPassed = false;
        devProblems.push('catalogue reference missing');
        issues.push({
          type: 'DEVICE',
          assetType: 'DEVICE',
          assetId: dev.deviceId,
          code: 'DEVICE_CATALOGUE_MISSING',
          message: `${dev.deviceId} catalogue reference not found`
        });
      }

      if (connectedCount > maxChannels) {
        devPassed = false;
        devProblems.push(`capacity exceeded (${connectedCount} / ${maxChannels} slots used)`);
        issues.push({
          type: 'DEVICE',
          assetType: 'DEVICE',
          assetId: dev.deviceId,
          code: 'DEVICE_CAPACITY_EXCEEDED',
          message: `${dev.deviceId} capacity exceeded (${connectedCount} / ${maxChannels} slots used)`
        });
      }
    } else {
      // Unused devices do not fail verification if uncommissioned
      if (connectedCount > maxChannels) {
        devPassed = false;
        devProblems.push(`capacity exceeded (${connectedCount} / ${maxChannels} slots used)`);
        issues.push({
          type: 'DEVICE',
          assetType: 'DEVICE',
          assetId: dev.deviceId,
          code: 'DEVICE_CAPACITY_EXCEEDED',
          message: `${dev.deviceId} capacity exceeded (${connectedCount} / ${maxChannels} slots used)`
        });
      }
    }

    assetStatuses.devices.push({
      id: dev._id,
      deviceId: dev.deviceId,
      name: dev.name,
      status: getDeviceCommissioningStatus(dev),
      runtimeStatus: dev.runtimeStatus || (['ONLINE', 'OFFLINE'].includes(dev.status) ? dev.status : 'OFFLINE'),
      isInUse,
      isCommissioned: commissioned,
      connectedSensors: connectedCount,
      maxChannels,
      passed: devPassed,
      message: devPassed 
        ? `${dev.deviceId} commissioned` 
        : `${dev.deviceId} ${devProblems.join(', ')}`
    });
  }

  // ----------------------------------------------------
  // C. VALIDATE ACTUAL GATEWAY STATE
  // ----------------------------------------------------
  const gatewayDeviceCountMap = new Map();
  for (const dm of deviceMappings) {
    const gwId = dm.gatewayAssetId.toString();
    gatewayDeviceCountMap.set(gwId, (gatewayDeviceCountMap.get(gwId) || 0) + 1);
  }

  for (const gw of gateways) {
    const gwIdStr = gw._id.toString();
    const cat = gatewayCatMap.get(gw.gateway_uid || gw.metadata?.gateway_uid);
    const mappedDevCount = gatewayDeviceCountMap.get(gwIdStr) || 0;
    const maxDevices = cat?.max_devices || gw.metadata?.max_devices || 100;

    let gwPassed = true;
    const gwProblems = [];

    if (gw.status !== 'COMMISSIONED') {
      gwPassed = false;
      gwProblems.push('Gateway not commissioned');
      issues.push({
        type: 'GATEWAY',
        assetType: 'Gateway',
        assetId: gw.gatewayId,
        code: 'GATEWAY_NOT_COMMISSIONED',
        message: `${gw.gatewayId} Gateway not commissioned`
      });
    }

    if (mappedDevCount > maxDevices) {
      gwPassed = false;
      gwProblems.push(`capacity exceeded (${mappedDevCount} / ${maxDevices} devices mapped)`);
      issues.push({
        type: 'GATEWAY',
        assetType: 'Gateway',
        assetId: gw.gatewayId,
        code: 'GATEWAY_CAPACITY_EXCEEDED',
        message: `${gw.gatewayId} capacity exceeded (${mappedDevCount} / ${maxDevices} devices mapped)`
      });
    }

    assetStatuses.gateways.push({
      id: gw._id,
      gatewayId: gw.gatewayId,
      name: gw.name,
      status: gw.status,
      mappedDevices: mappedDevCount,
      maxDevices,
      passed: gwPassed,
      message: gwPassed ? `${gw.gatewayId} commissioned` : `${gw.gatewayId} ${gwProblems.join(', ')}`
    });
  }

  // ----------------------------------------------------
  // D. SENSOR → DEVICE MAPPING VALIDATION
  // ----------------------------------------------------
  const seenSensorMappings = new Set();
  const deviceSlotMap = new Map(); // devId -> Set of slots

  for (const sm of sensorMappings) {
    const sId = sm.sensorAssetId.toString();
    const dId = sm.deviceAssetId.toString();
    const sensor = instMap.get(sId);
    const device = devMap.get(dId);

    // 1. One sensor does not have multiple active mappings
    if (seenSensorMappings.has(sId)) {
      issues.push({
        type: 'MAPPING',
        assetType: 'SensorDeviceMapping',
        assetId: sm._id.toString(),
        code: 'SENSOR_DUPLICATE_MAPPING',
        message: `Sensor '${sensor?.code || sId}' has multiple active device mappings`
      });
    }
    seenSensorMappings.add(sId);

    // 2. Sensor and device belong to project and are active
    if (!sensor || ['DECOMMISSIONED', 'INACTIVE'].includes(sensor.status)) {
      issues.push({
        type: 'MAPPING',
        assetType: 'SensorDeviceMapping',
        assetId: sm._id.toString(),
        code: 'SENSOR_INACTIVE',
        message: `Sensor '${sensor?.code || sId}' is inactive or not found`
      });
    }
    if (!device || ['DECOMMISSIONED', 'INACTIVE'].includes(device.status)) {
      issues.push({
        type: 'MAPPING',
        assetType: 'SensorDeviceMapping',
        assetId: sm._id.toString(),
        code: 'DEVICE_INACTIVE',
        message: `Device '${device?.deviceId || dId}' is inactive or not found`
      });
    }

    // 3. Slot duplicate check on same device
    const slot = sm.connection?.slot;
    if (slot != null) {
      if (!deviceSlotMap.has(dId)) deviceSlotMap.set(dId, new Set());
      const devSlots = deviceSlotMap.get(dId);
      if (devSlots.has(slot)) {
        issues.push({
          type: 'MAPPING',
          assetType: 'SensorDeviceMapping',
          assetId: sm._id.toString(),
          code: 'DEVICE_DUPLICATE_SLOT',
          message: `Slot ${slot} on Device '${device?.deviceId || dId}' is assigned to multiple sensors`
        });
      }
      devSlots.add(slot);
    }

    // 4. Signal compatibility check
    if (sensor && device) {
      const sensorCat = sensorCatMap.get(sensor.sensor_uid || sensor.catalogCode);
      const devCat = deviceCatMap.get(device.device_uid || device.metadata?.device_uid);
      const signalType = sensorCat?.signal_type || sensor.metadata?.signal_type || 'vibrating_wire';
      const supportedSignals = devCat?.supported_signal_types || device.metadata?.supported_signal_types || ['vibrating_wire', 'rs485'];

      if (!supportedSignals.includes(signalType)) {
        issues.push({
          type: 'MAPPING',
          assetType: 'SensorDeviceMapping',
          assetId: sm._id.toString(),
          code: 'INCOMPATIBLE_SIGNAL',
          message: `Incompatible signal type: Sensor '${sensor.code}' (${signalType}) -> Device '${device.deviceId}' [${supportedSignals.join(', ')}]`
        });
      }
    }
  }

  // ----------------------------------------------------
  // E. DEVICE → GATEWAY MAPPING VALIDATION
  // ----------------------------------------------------
  for (const dev of devices) {
    const devIdStr = dev._id.toString();
    const devCat = deviceCatMap.get(dev.device_uid || dev.metadata?.device_uid);
    const comm = devCat?.communication || (dev.transport === 'LORAWAN' ? 'lorawan' : (dev.transport ? dev.transport.toLowerCase() : '4g'));
    const isDirectCloud = comm === '4g';
    const gwMapping = deviceMappings.find(m => m.deviceAssetId.toString() === devIdStr);

    if (comm === 'lorawan') {
      if (!gwMapping) {
        issues.push({
          type: 'MAPPING',
          assetType: 'DeviceGatewayMapping',
          assetId: dev.deviceId,
          code: 'GATEWAY_MAPPING_REQUIRED',
          message: `LoRaWAN Device '${dev.deviceId}' requires an active compatible Gateway mapping`
        });
      } else {
        const gw = gwMap.get(gwMapping.gatewayAssetId.toString());
        if (!gw || ['DECOMMISSIONED', 'INACTIVE'].includes(gw.status)) {
          issues.push({
            type: 'MAPPING',
            assetType: 'DeviceGatewayMapping',
            assetId: dev.deviceId,
            code: 'GATEWAY_INACTIVE',
            message: `Gateway mapped to Device '${dev.deviceId}' is inactive or not found`
          });
        } else {
          // LoRaWAN gateway must be COMMISSIONED
          if (gw.status !== 'COMMISSIONED') {
            // Already flagged in Gateways section, but mapping also records requirement
          }

          const gwCat = gatewayCatMap.get(gw.gateway_uid || gw.metadata?.gateway_uid);
          const supportedComms = gwCat?.supported_device_communications || gw.metadata?.supported_device_communications || ['lorawan'];
          if (!supportedComms.includes(comm)) {
            issues.push({
              type: 'MAPPING',
              assetType: 'DeviceGatewayMapping',
              assetId: dev.deviceId,
              code: 'INCOMPATIBLE_GATEWAY_COMM',
              message: `Device '${dev.deviceId}' communication '${comm}' is incompatible with Gateway '${gw.gatewayId}' [${supportedComms.join(', ')}]`
            });
          }
        }
      }
    } else if (isDirectCloud) {
      // 4G Direct Cloud is valid without Gateway.
    }
  }

  // Mapping status summary
  const mappingIssues = issues.filter(i => i.type === 'MAPPING');
  assetStatuses.mappings.push({
    passed: mappingIssues.length === 0,
    message: mappingIssues.length === 0
      ? 'Existing Sensor and Device mappings compatible'
      : `${mappingIssues.length} mapping conflict(s) detected`
  });

  // ----------------------------------------------------
  // F. GROUPED CHECKLIST SUMMARY
  // ----------------------------------------------------
  const checks = [
    {
      key: 'sensors_commissioned',
      name: 'Active Sensors commissioned',
      passed: instruments.length > 0 && instruments.every(i => i.status === 'COMMISSIONED'),
      message: `${commissionedSensors} / ${registeredSensors} active sensors commissioned`
    },
    {
      key: 'sensor_mappings_valid',
      name: 'Sensor → Device mappings valid',
      passed: !issues.some(i => i.code === 'INCOMPATIBLE_SIGNAL' || i.code === 'SENSOR_DUPLICATE_MAPPING' || i.code === 'DEVICE_DUPLICATE_SLOT'),
      message: 'Sensor → Device mappings compatible'
    },
    {
      key: 'devices_commissioned',
      name: 'In-use Devices commissioned',
      passed: inUseDeviceIdSet.size === 0 || Array.from(inUseDeviceIdSet).every(id => {
        const d = devMap.get(id);
        return d && isDeviceCommissioned(d);
      }),
      message: `${Array.from(inUseDeviceIdSet).filter(id => {
        const d = devMap.get(id);
        return d && isDeviceCommissioned(d);
      }).length} / ${inUseDeviceIdSet.size} in-use devices commissioned`
    },
    {
      key: 'device_capacities_valid',
      name: 'Device capacities valid',
      passed: !issues.some(i => i.code === 'DEVICE_CAPACITY_EXCEEDED'),
      message: 'All device channel capacities valid'
    },
    {
      key: 'device_gateway_mappings_valid',
      name: 'Device → Gateway mappings valid',
      passed: !issues.some(i => i.code === 'GATEWAY_MAPPING_REQUIRED' || i.code === 'INCOMPATIBLE_GATEWAY_COMM'),
      message: 'Device → Gateway mappings valid'
    },
    {
      key: 'gateways_commissioned',
      name: 'Required Gateways commissioned',
      passed: gateways.length > 0 && gateways.every(g => g.status === 'COMMISSIONED'),
      message: `${commissionedGateways} / ${registeredGateways} gateways commissioned`
    },
    {
      key: 'gateway_capacities_valid',
      name: 'Gateway capacities valid',
      passed: !issues.some(i => i.code === 'GATEWAY_CAPACITY_EXCEEDED'),
      message: 'Gateway capacities valid'
    }
  ];

  // ----------------------------------------------------
  // G. PLANNED SCOPE WARNINGS (NON-BLOCKING)
  // ----------------------------------------------------
  if (registeredSensors !== plannedSensors) {
    if (registeredSensors < plannedSensors) {
      warnings.push(`${plannedSensors - registeredSensors} planned Sensors have not been registered.`);
    } else {
      warnings.push(`${registeredSensors - plannedSensors} additional Sensors registered beyond original plan.`);
    }
  }
  if (registeredDevices !== plannedDevices) {
    if (registeredDevices < plannedDevices) {
      warnings.push(`${plannedDevices - registeredDevices} planned Devices have not been registered.`);
    } else {
      warnings.push(`${registeredDevices - plannedDevices} additional Devices registered beyond original plan.`);
    }
  }
  if (registeredGateways !== plannedGateways) {
    if (registeredGateways < plannedGateways) {
      warnings.push(`${plannedGateways - registeredGateways} planned Gateways have not been registered.`);
    } else {
      warnings.push(`${registeredGateways - plannedGateways} additional Gateways registered beyond original plan.`);
    }
  }

  const scopeMismatch = registeredSensors !== plannedSensors ||
    registeredDevices !== plannedDevices ||
    registeredGateways !== plannedGateways;

  // Technical verification ready state: ONLY technical issues fail verification!
  // Planned quantity differences do NOT block ready.
  const ready = issues.length === 0;

  // Safe repair: If project has setupStatus === 'COMMISSIONED' but technical verification fails,
  // downgrade setupStatus to 'COMMISSIONING' and unset invalid completion timestamps.
  if (project.setupStatus === 'COMMISSIONED' && !ready) {
    await Project.updateOne(
      { _id: project._id },
      {
        $set: { setupStatus: 'COMMISSIONING' },
        $unset: { commissioningCompletedAt: 1, commissioningCompletedBy: 1 }
      }
    );
    project.setupStatus = 'COMMISSIONING';
    project.commissioningCompletedAt = null;
    project.commissioningCompletedBy = null;
  }

  return {
    projectId: project._id,
    projectName: project.name,
    projectCode: project.code,
    setupStatus: project.setupStatus || 'SETUP_REQUIRED',
    status: project.status || 'ACTIVE',
    commissioningCompletedAt: project.commissioningCompletedAt || null,
    commissioningCompletedBy: project.commissioningCompletedBy || null,
    ready,
    summary: {
      plannedSensors,
      registeredSensors,
      commissionedSensors,
      plannedDevices,
      registeredDevices,
      commissionedDevices,
      plannedGateways,
      registeredGateways,
      commissionedGateways,
      sensorDeviceMappings: sensorMappings.length,
      deviceGatewayMappings: deviceMappings.length
    },
    issues,
    warnings,
    scopeMismatch,
    checks,
    assetStatuses
  };
}

/**
 * Confirms Project Commissioning
 * Re-validates server-side, sets Project.setupStatus = COMMISSIONED,
 * writes commissioningCompletedAt & commissioningCompletedBy, and logs audit event.
 */
export async function confirmProjectCommissioning(projectIdParam, userId, req = null) {
  // Re-run project commissioning validation on live server data
  const validationResult = await validateProjectCommissioning(projectIdParam);

  if (!validationResult.ready) {
    throw new ApiError(400, `Cannot confirm project commissioning: Verification failed with ${validationResult.issues.length} issue(s).`, {
      issues: validationResult.issues
    });
  }

  const project = await Project.findById(validationResult.projectId);
  if (!project) throw new ApiError(404, 'Project not found');

  const previousSetupStatus = project.setupStatus;
  const completedAt = new Date();

  project.setupStatus = 'COMMISSIONED';
  project.commissioningCompletedAt = completedAt;
  project.commissioningCompletedBy = userId || req?.auth?.userId;
  await project.save();

  // Retrieve user displayName for response
  let completedByUser = null;
  if (project.commissioningCompletedBy) {
    completedByUser = await User.findById(project.commissioningCompletedBy).select('displayName email').lean();
  }

  // Audit event PROJECT_COMMISSIONED
  await audit({
    req,
    organizationId: project.organizationId,
    projectId: project._id,
    action: 'PROJECT_COMMISSIONED',
    resourceType: 'Project',
    resourceId: project._id,
    previousState: { setupStatus: previousSetupStatus },
    newState: {
      setupStatus: 'COMMISSIONED',
      commissioningCompletedAt: completedAt,
      commissioningCompletedBy: project.commissioningCompletedBy
    }
  });

  return {
    success: true,
    message: 'Project successfully commissioned',
    project: {
      _id: project._id,
      name: project.name,
      code: project.code,
      status: project.status,
      setupStatus: project.setupStatus,
      commissioningCompletedAt: project.commissioningCompletedAt,
      commissioningCompletedBy: project.commissioningCompletedBy,
      completedByUserName: completedByUser?.displayName || completedByUser?.email || 'Current User'
    },
    summary: validationResult.summary,
    warnings: validationResult.warnings,
    scopeMismatch: validationResult.scopeMismatch
  };
}
