import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { 
  Project, Instrument, Device, ProjectGateway, 
  SensorDeviceMapping, DeviceGatewayMapping, 
  Sensor, DeviceCatalogue, GatewayCatalogue, 
  SensorChannel, Site, Zone 
} from '../models/index.js';
import { requireAuth, requireProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from '../services/audit.service.js';
import { randomToken, sha256 } from '../utils/crypto.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

async function resolveProject(projectId) {
  if (!projectId) throw new ApiError(400, 'Project ID is required');
  const query = mongoose.Types.ObjectId.isValid(projectId)
    ? { _id: projectId }
    : { code: String(projectId).toUpperCase() };
  const project = await Project.findOne(query).lean();
  if (!project) throw new ApiError(404, 'Project not found');
  return project;
}

/**
 * 1. GET /projects/:projectId/commissioning/summary
 * Returns planned configuration progress against actual registered assets.
 * All counts derived from actual DB asset records - never modifying plannedConfiguration.
 */
router.get('/projects/:projectId/commissioning/summary', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId: rawProjectId } = req.params;
  const project = await resolveProject(rawProjectId);
  const projectId = project._id;

  const planned = project.plannedConfiguration || { sensors: [], devices: [], gateways: [] };

  // Fetch all catalogue definitions referenced in planned configuration
  const sensorUids = (planned.sensors || []).map(s => s.sensor_uid);
  const deviceUids = (planned.devices || []).map(d => d.device_uid);
  const gatewayUids = (planned.gateways || []).map(g => g.gateway_uid);

  const [sensorCatalogues, deviceCatalogues, gatewayCatalogues] = await Promise.all([
    Sensor.find({ uid: { $in: sensorUids } }).lean(),
    DeviceCatalogue.find({ uid: { $in: deviceUids } }).lean(),
    GatewayCatalogue.find({ uid: { $in: gatewayUids } }).lean()
  ]);

  const sensorCatMap = new Map(sensorCatalogues.map(c => [c.uid, c]));
  const deviceCatMap = new Map(deviceCatalogues.map(c => [c.uid, c]));
  const gatewayCatMap = new Map(gatewayCatalogues.map(c => [c.uid, c]));

  // Calculate actual registered sensors progress
  const sensorProgress = await Promise.all((planned.sensors || []).map(async (item) => {
    const cat = sensorCatMap.get(item.sensor_uid) || {};
    const registeredCount = await Instrument.countDocuments({
      projectId,
      status: { $ne: 'DECOMMISSIONED' },
      $or: [
        { sensor_uid: item.sensor_uid },
        { catalogCode: item.sensor_uid },
        { 'metadata.sensor_uid': item.sensor_uid }
      ]
    });
    const registeredDocs = await Instrument.find({
      projectId,
      status: { $ne: 'DECOMMISSIONED' },
      $or: [
        { sensor_uid: item.sensor_uid },
        { catalogCode: item.sensor_uid },
        { 'metadata.sensor_uid': item.sensor_uid }
      ]
    }).select('_id code deviceId name status serial serialNumber').lean();

    return {
      sensor_uid: item.sensor_uid,
      name: item.name || cat.name || item.sensor_uid,
      model: item.model || cat.model || '—',
      signal_type: item.signal_type || cat.signal_type || 'vibrating_wire',
      type: cat.type || 'General',
      plannedQuantity: item.quantity,
      registeredCount,
      remaining: Math.max(0, item.quantity - registeredCount),
      registeredAssets: registeredDocs.map(d => ({
        _id: d._id,
        code: d.code || d.deviceId || d.name,
        deviceId: d.deviceId,
        name: d.name,
        status: d.status,
        serial: d.serial || d.serialNumber || '—'
      }))
    };
  }));

  // Calculate actual registered devices progress and capacity
  const deviceProgress = await Promise.all((planned.devices || []).map(async (item) => {
    const cat = deviceCatMap.get(item.device_uid) || {};
    const registeredCount = await Device.countDocuments({
      projectId,
      status: { $ne: 'DECOMMISSIONED' },
      $or: [
        { device_uid: item.device_uid },
        { 'metadata.device_uid': item.device_uid }
      ]
    });
    return {
      device_uid: item.device_uid,
      name: item.name || cat.name || item.device_uid,
      model: item.model || cat.model || '—',
      communication: item.communication || cat.communication || 'lorawan',
      supported_signal_types: item.supported_signal_types || cat.supported_signal_types || [],
      max_channels: cat.max_channels || 8,
      plannedQuantity: item.quantity,
      registeredCount,
      remaining: Math.max(0, item.quantity - registeredCount)
    };
  }));

  // Calculate actual registered gateways progress
  const gatewayProgress = await Promise.all((planned.gateways || []).map(async (item) => {
    const cat = gatewayCatMap.get(item.gateway_uid) || {};
    const registeredCount = await ProjectGateway.countDocuments({
      projectId,
      status: { $ne: 'DECOMMISSIONED' },
      $or: [
        { gateway_uid: item.gateway_uid },
        { 'metadata.gateway_uid': item.gateway_uid }
      ]
    });
    return {
      gateway_uid: item.gateway_uid,
      name: item.name || cat.name || item.gateway_uid,
      model: item.model || cat.model || '—',
      supported_device_communications: item.supported_device_communications || cat.supported_device_communications || [],
      backhaul: item.backhaul || cat.backhaul || [],
      max_devices: cat.max_devices || 100,
      plannedQuantity: item.quantity,
      registeredCount,
      remaining: Math.max(0, item.quantity - registeredCount)
    };
  }));

  // Summary totals
  const totalSensorsPlanned = sensorProgress.reduce((sum, s) => sum + s.plannedQuantity, 0);
  const totalSensorsRegistered = sensorProgress.reduce((sum, s) => sum + s.registeredCount, 0);
  const totalDevicesPlanned = deviceProgress.reduce((sum, d) => sum + d.plannedQuantity, 0);
  const totalDevicesRegistered = deviceProgress.reduce((sum, d) => sum + d.registeredCount, 0);
  const totalGatewaysPlanned = gatewayProgress.reduce((sum, g) => sum + g.plannedQuantity, 0);
  const totalGatewaysRegistered = gatewayProgress.reduce((sum, g) => sum + g.registeredCount, 0);

  // Active mapping statistics
  const [activeSensorMappingsCount, activeDeviceMappingsCount] = await Promise.all([
    SensorDeviceMapping.countDocuments({ projectId, status: 'ACTIVE' }),
    DeviceGatewayMapping.countDocuments({ projectId, status: 'ACTIVE' })
  ]);

  res.json({
    projectId,
    projectName: project.name,
    projectCode: project.code,
    setupStatus: project.setupStatus || null,
    sensorProgress,
    deviceProgress,
    gatewayProgress,
    totals: {
      sensors: { planned: totalSensorsPlanned, registered: totalSensorsRegistered, mapped: activeSensorMappingsCount },
      devices: { planned: totalDevicesPlanned, registered: totalDevicesRegistered, mapped: activeDeviceMappingsCount },
      gateways: { planned: totalGatewaysPlanned, registered: totalGatewaysRegistered }
    }
  });
}));

/**
 * 2. GET /projects/:projectId/commissioning/sensors
 * Returns all actual registered sensors with their resolved catalogue info & active device mapping.
 */
router.get('/projects/:projectId/commissioning/sensors', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId: rawProjectId } = req.params;
  const project = await resolveProject(rawProjectId);
  const projectId = project._id;

  const instruments = await Instrument.find({ 
    projectId, 
    status: { $ne: 'DECOMMISSIONED' } 
  }).sort({ code: 1 }).lean();

  const activeMappings = await SensorDeviceMapping.find({ 
    projectId, 
    status: 'ACTIVE' 
  }).populate('deviceAssetId', 'deviceId name device_uid transport').lean();

  const mappingMap = new Map(activeMappings.map(m => [m.sensorAssetId.toString(), m]));

  const uids = [...new Set(instruments.map(i => i.sensor_uid || i.catalogCode).filter(Boolean))];
  const catalogues = await Sensor.find({ uid: { $in: uids } }).lean();
  const catMap = new Map(catalogues.map(c => [c.uid, c]));

  const result = instruments.map(inst => {
    const uid = inst.sensor_uid || inst.catalogCode;
    const cat = catMap.get(uid) || {};
    const mapping = mappingMap.get(inst._id.toString());
    const assignedDevice = mapping?.deviceAssetId ? {
      _id: mapping.deviceAssetId._id,
      deviceId: mapping.deviceAssetId.deviceId,
      name: mapping.deviceAssetId.name
    } : null;

    return {
      _id: inst._id,
      code: inst.code,
      name: inst.name,
      serial: inst.serial || '',
      sensor_uid: uid,
      catalogName: cat.name || inst.name,
      model: cat.model || inst.metadata?.model || '—',
      signal_type: cat.signal_type || inst.metadata?.signal_type || 'vibrating_wire',
      type: cat.type || 'General',
      measurementChannels: cat.channels || [],
      status: inst.status,
      isAssigned: !!mapping,
      assignedDevice,
      connectionSlot: mapping?.connection?.slot != null ? mapping.connection.slot : null,
      connection: mapping?.connection || null,
      mappingId: mapping?._id || null,
      mappedAt: mapping?.mappedAt || null
    };
  });

  res.json(result);
}));

/**
 * 3. POST /projects/:projectId/commissioning/sensors/bulk-register
 * Bulk registers actual physical sensors (Instruments) for a planned catalogue item.
 */
const bulkRegisterSensorsSchema = z.object({
  sensors: z.array(z.object({
    code: z.string().min(1, 'Asset ID is required'),
    serial: z.string().optional().default(''),
    sensor_uid: z.string().min(1, 'Catalogue Sensor UID is required'),
    name: z.string().optional(),
    siteId: z.string().optional(),
    zoneId: z.string().optional()
  })).min(1, 'At least one sensor is required')
});

router.post('/projects/:projectId/commissioning/sensors/bulk-register', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const project = await Project.findById(projectId).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const { sensors } = bulkRegisterSensorsSchema.parse(req.body);

  // Check for duplicate codes within request
  const codesInPayload = sensors.map(s => s.code.trim().toUpperCase());
  if (new Set(codesInPayload).size !== codesInPayload.length) {
    throw new ApiError(400, 'Duplicate Asset IDs found in registration batch');
  }

  // Check if any code already exists for this project
  const existingWithCodes = await Instrument.find({
    projectId,
    code: { $in: codesInPayload.map(c => new RegExp(`^${c}$`, 'i')) }
  }).lean();

  if (existingWithCodes.length > 0) {
    const conflictCodes = existingWithCodes.map(e => e.code).join(', ');
    throw new ApiError(409, `Asset ID(s) already exist in project: ${conflictCodes}`);
  }

  // Lookup Sensor catalogue definitions
  const sensorUids = [...new Set(sensors.map(s => s.sensor_uid))];
  const catalogues = await Sensor.find({ uid: { $in: sensorUids } }).lean();
  const catMap = new Map(catalogues.map(c => [c.uid, c]));

  // Default site & zone if none specified
  const firstSite = await Site.findOne({ projectId }).sort({ level: 1 }).lean();
  const firstZone = await Zone.findOne({ projectId }).sort({ createdAt: 1 }).lean();

  const createdInstruments = [];

  for (const item of sensors) {
    const cat = catMap.get(item.sensor_uid);
    if (!cat) {
      throw new ApiError(400, `Catalogue sensor '${item.sensor_uid}' not found`);
    }

    const code = item.code.trim().toUpperCase();
    const name = item.name?.trim() || `${cat.name} ${code}`;

    const instrument = await Instrument.create({
      organizationId: req.auth.organizationId,
      projectId,
      siteId: item.siteId || firstSite?._id,
      zoneId: item.zoneId || firstZone?._id,
      catalogCode: cat.uid,
      sensor_uid: cat.uid,
      name,
      code,
      serial: item.serial ? item.serial.trim() : '',
      status: 'REGISTERED',
      metadata: {
        sensor_uid: cat.uid,
        model: cat.model,
        signal_type: cat.signal_type,
        channelsCount: cat.channels?.length || 1
      }
    });

    // Create default sensor channels from catalogue definition
    for (const ch of cat.channels || []) {
      await SensorChannel.create({
        organizationId: req.auth.organizationId,
        projectId,
        instrumentId: instrument._id,
        code: `${code}-${ch.measurement}`,
        sourceField: ch.measurement,
        parameterCode: ch.measurement,
        rawUnit: ch.unit,
        engineeringUnit: ch.unit,
        sampleIntervalSec: 900,
        calibration: { scale: 1, offset: 0, version: 1 },
        baseline: { value: 0, version: 1 },
        qualityConfig: {}
      });
    }

    createdInstruments.push(instrument);
  }

  if (createdInstruments.length > 0 && project.setupStatus === 'SETUP_REQUIRED') {
    await Project.updateOne({ _id: projectId }, { $set: { setupStatus: 'COMMISSIONING' } });
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId,
    action: 'INSTRUMENTS_BULK_REGISTERED',
    resourceType: 'Instrument',
    resourceId: project._id,
    newState: { count: createdInstruments.length, codes: createdInstruments.map(i => i.code) }
  });

  res.status(201).json({
    message: `Successfully registered ${createdInstruments.length} sensor(s)`,
    count: createdInstruments.length,
    sensors: createdInstruments
  });
}));

/**
 * 4. GET /projects/:projectId/commissioning/devices
 * Returns all actual registered devices with catalogue info, capacity & active gateway mappings.
 */
router.get('/projects/:projectId/commissioning/devices', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId: rawProjectId } = req.params;
  const project = await resolveProject(rawProjectId);
  const projectId = project._id;

  const devices = await Device.find({ 
    projectId, 
    status: { $ne: 'DECOMMISSIONED' } 
  }).sort({ deviceId: 1 }).lean();

  const deviceUids = [...new Set(devices.map(d => d.device_uid || d.metadata?.device_uid).filter(Boolean))];
  const catalogues = await DeviceCatalogue.find({ uid: { $in: deviceUids } }).lean();
  const catMap = new Map(catalogues.map(c => [c.uid, c]));

  // Active sensor mappings per device
  const activeSensorMappings = await SensorDeviceMapping.find({ projectId, status: 'ACTIVE' }).lean();
  const sensorCountMap = new Map();
  for (const m of activeSensorMappings) {
    const devId = m.deviceAssetId.toString();
    sensorCountMap.set(devId, (sensorCountMap.get(devId) || 0) + 1);
  }

  // Active gateway mappings per device
  const activeGatewayMappings = await DeviceGatewayMapping.find({ 
    projectId, 
    status: 'ACTIVE' 
  }).populate('gatewayAssetId', 'gatewayId name gateway_uid').lean();
  const gatewayMappingMap = new Map(activeGatewayMappings.map(m => [m.deviceAssetId.toString(), m]));

  const result = devices.map(d => {
    const uid = d.device_uid || d.metadata?.device_uid;
    const cat = catMap.get(uid) || {};
    const connectedSensors = sensorCountMap.get(d._id.toString()) || 0;
    const maxChannels = cat.max_channels || 8;
    const availableSlots = Math.max(0, maxChannels - connectedSensors);
    const gwMapping = gatewayMappingMap.get(d._id.toString());
    const communication = cat.communication || (d.transport === 'LORAWAN' ? 'lorawan' : '4g');
    const isDirectCloud = communication === '4g';

    return {
      _id: d._id,
      deviceId: d.deviceId,
      name: d.name,
      serial: d.serial || d.metadata?.serial || '',
      device_uid: uid,
      catalogName: cat.name || d.name,
      model: cat.model || '—',
      communication,
      supported_signal_types: cat.supported_signal_types || ['vibrating_wire', 'rs485'],
      max_channels: maxChannels,
      connectedSensors,
      availableSlots,
      status: d.status,
      isDirectCloud,
      isGatewayAssigned: !!gwMapping,
      assignedGateway: gwMapping?.gatewayAssetId ? {
        _id: gwMapping.gatewayAssetId._id,
        gatewayId: gwMapping.gatewayAssetId.gatewayId,
        name: gwMapping.gatewayAssetId.name
      } : null,
      gatewayMappingId: gwMapping?._id || null
    };
  });

  res.json(result);
}));

/**
 * 5. POST /projects/:projectId/commissioning/devices/bulk-register
 * Bulk registers actual physical devices for a planned catalogue item.
 */
const bulkRegisterDevicesSchema = z.object({
  devices: z.array(z.object({
    deviceId: z.string().min(1, 'Device ID is required'),
    serial: z.string().optional().default(''),
    device_uid: z.string().min(1, 'Catalogue Device UID is required'),
    name: z.string().optional(),
    firmware: z.string().optional()
  })).min(1, 'At least one device is required')
});

router.post('/projects/:projectId/commissioning/devices/bulk-register', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const project = await Project.findById(projectId).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const { devices } = bulkRegisterDevicesSchema.parse(req.body);

  // Check for duplicate deviceIds within request
  const idsInPayload = devices.map(d => d.deviceId.trim().toUpperCase());
  if (new Set(idsInPayload).size !== idsInPayload.length) {
    throw new ApiError(400, 'Duplicate Device IDs found in registration batch');
  }

  // Check if any deviceId already exists in this organization
  const existingWithIds = await Device.find({
    organizationId: req.auth.organizationId,
    deviceId: { $in: idsInPayload.map(id => new RegExp(`^${id}$`, 'i')) }
  }).lean();

  if (existingWithIds.length > 0) {
    const conflictIds = existingWithIds.map(e => e.deviceId).join(', ');
    throw new ApiError(409, `Device ID(s) already exist: ${conflictIds}`);
  }

  // Lookup Device catalogue definitions
  const deviceUids = [...new Set(devices.map(d => d.device_uid))];
  const catalogues = await DeviceCatalogue.find({ uid: { $in: deviceUids } }).lean();
  const catMap = new Map(catalogues.map(c => [c.uid, c]));

  const createdDevices = [];

  for (const item of devices) {
    const cat = catMap.get(item.device_uid);
    if (!cat) {
      throw new ApiError(400, `Catalogue device '${item.device_uid}' not found`);
    }

    const deviceId = item.deviceId.trim().toUpperCase();
    const name = item.name?.trim() || `${cat.name} ${deviceId}`;
    const apiKey = `gxn_${randomToken(16)}`;

    const device = await Device.create({
      organizationId: req.auth.organizationId,
      projectId,
      deviceId,
      device_uid: cat.uid,
      serial: item.serial ? item.serial.trim() : '',
      name,
      deviceType: cat.type || 'LOGGER',
      transport: cat.communication === 'lorawan' ? 'LORAWAN' : '4G',
      firmware: item.firmware || '1.0.0',
      apiKeyHash: sha256(apiKey),
      apiKeyPrefix: apiKey.slice(0, 10),
      status: 'REGISTERED',
      metadata: {
        device_uid: cat.uid,
        communication: cat.communication,
        max_channels: cat.max_channels
      }
    });

    createdDevices.push(device);
  }

  if (createdDevices.length > 0 && project.setupStatus === 'SETUP_REQUIRED') {
    await Project.updateOne({ _id: projectId }, { $set: { setupStatus: 'COMMISSIONING' } });
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId,
    action: 'DEVICES_BULK_REGISTERED',
    resourceType: 'Device',
    resourceId: project._id,
    newState: { count: createdDevices.length, deviceIds: createdDevices.map(d => d.deviceId) }
  });

  res.status(201).json({
    message: `Successfully registered ${createdDevices.length} device(s)`,
    count: createdDevices.length,
    devices: createdDevices
  });
}));

/**
 * 6. GET /projects/:projectId/commissioning/gateways
 * Returns all actual registered gateways with catalogue info & capacity.
 */
router.get('/projects/:projectId/commissioning/gateways', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId: rawProjectId } = req.params;
  const project = await resolveProject(rawProjectId);
  const projectId = project._id;

  const gateways = await ProjectGateway.find({ 
    projectId, 
    status: { $ne: 'DECOMMISSIONED' } 
  }).sort({ gatewayId: 1 }).lean();

  const gatewayUids = [...new Set(gateways.map(g => g.gateway_uid).filter(Boolean))];
  const catalogues = await GatewayCatalogue.find({ uid: { $in: gatewayUids } }).lean();
  const catMap = new Map(catalogues.map(c => [c.uid, c]));

  // Active mapped devices per gateway
  const activeMappings = await DeviceGatewayMapping.find({ projectId, status: 'ACTIVE' }).lean();
  const mappedCountMap = new Map();
  for (const m of activeMappings) {
    const gwId = m.gatewayAssetId.toString();
    mappedCountMap.set(gwId, (mappedCountMap.get(gwId) || 0) + 1);
  }

  const result = gateways.map(g => {
    const cat = catMap.get(g.gateway_uid) || {};
    const mappedDevices = mappedCountMap.get(g._id.toString()) || 0;
    const maxDevices = cat.max_devices || 100;
    const availableDevices = Math.max(0, maxDevices - mappedDevices);

    return {
      _id: g._id,
      gatewayId: g.gatewayId,
      name: g.name,
      serial: g.serial || '',
      imei: g.imei || '',
      macAddress: g.macAddress || '',
      gateway_uid: g.gateway_uid,
      catalogName: cat.name || g.name,
      model: cat.model || '—',
      supported_device_communications: cat.supported_device_communications || ['lorawan'],
      backhaul: cat.backhaul || ['ethernet', '4g'],
      max_devices: maxDevices,
      mappedDevices,
      availableDevices,
      status: g.status
    };
  });

  res.json(result);
}));

/**
 * 7. POST /projects/:projectId/commissioning/gateways/bulk-register
 * Bulk registers actual physical gateways for a planned catalogue item.
 */
const bulkRegisterGatewaysSchema = z.object({
  gateways: z.array(z.object({
    gatewayId: z.string().min(1, 'Gateway ID is required'),
    serial: z.string().optional().default(''),
    gateway_uid: z.string().min(1, 'Catalogue Gateway UID is required'),
    name: z.string().optional(),
    imei: z.string().optional(),
    macAddress: z.string().optional()
  })).min(1, 'At least one gateway is required')
});

router.post('/projects/:projectId/commissioning/gateways/bulk-register', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const project = await Project.findById(projectId).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const { gateways } = bulkRegisterGatewaysSchema.parse(req.body);

  // Check for duplicate gatewayIds within request
  const idsInPayload = gateways.map(g => g.gatewayId.trim().toUpperCase());
  if (new Set(idsInPayload).size !== idsInPayload.length) {
    throw new ApiError(400, 'Duplicate Gateway IDs found in registration batch');
  }

  // Check if any gatewayId already exists in this project
  const existingWithIds = await ProjectGateway.find({
    projectId,
    gatewayId: { $in: idsInPayload.map(id => new RegExp(`^${id}$`, 'i')) }
  }).lean();

  if (existingWithIds.length > 0) {
    const conflictIds = existingWithIds.map(e => e.gatewayId).join(', ');
    throw new ApiError(409, `Gateway ID(s) already exist in project: ${conflictIds}`);
  }

  // Lookup Gateway catalogue definitions
  const gatewayUids = [...new Set(gateways.map(g => g.gateway_uid))];
  const catalogues = await GatewayCatalogue.find({ uid: { $in: gatewayUids } }).lean();
  const catMap = new Map(catalogues.map(c => [c.uid, c]));

  const createdGateways = [];

  for (const item of gateways) {
    const cat = catMap.get(item.gateway_uid);
    if (!cat) {
      throw new ApiError(400, `Catalogue gateway '${item.gateway_uid}' not found`);
    }

    const gatewayId = item.gatewayId.trim().toUpperCase();
    const name = item.name?.trim() || `${cat.name} ${gatewayId}`;

    const gateway = await ProjectGateway.create({
      organizationId: req.auth.organizationId,
      projectId,
      gatewayId,
      gateway_uid: cat.uid,
      serial: item.serial ? item.serial.trim() : '',
      imei: item.imei ? item.imei.trim() : '',
      macAddress: item.macAddress ? item.macAddress.trim() : '',
      name,
      status: 'REGISTERED',
      metadata: {
        gateway_uid: cat.uid,
        supported_device_communications: cat.supported_device_communications,
        max_devices: cat.max_devices
      }
    });

    createdGateways.push(gateway);
  }

  if (createdGateways.length > 0 && project.setupStatus === 'SETUP_REQUIRED') {
    await Project.updateOne({ _id: projectId }, { $set: { setupStatus: 'COMMISSIONING' } });
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId,
    action: 'GATEWAYS_BULK_REGISTERED',
    resourceType: 'ProjectGateway',
    resourceId: project._id,
    newState: { count: createdGateways.length, gatewayIds: createdGateways.map(g => g.gatewayId) }
  });

  res.status(201).json({
    message: `Successfully registered ${createdGateways.length} gateway(s)`,
    count: createdGateways.length,
    gateways: createdGateways
  });
}));

/**
 * 8. POST /projects/:projectId/commissioning/sensor-device-mappings/bulk
 * Atomic bulk assignment of sensors to a device with strict capacity and compatibility validation.
 */
const bulkSensorDeviceMappingSchema = z.object({
  deviceAssetId: z.string().min(1, 'Target device is required'),
  sensorAssetIds: z.array(z.string()).min(1, 'At least one sensor must be selected'),
  autoAssignSlots: z.boolean().optional(),
  slotAssignments: z.array(z.object({
    sensorAssetId: z.string(),
    slot: z.number().int().min(1)
  })).optional()
});

router.post('/projects/:projectId/commissioning/sensor-device-mappings/bulk', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const { deviceAssetId, sensorAssetIds, autoAssignSlots, slotAssignments } = bulkSensorDeviceMappingSchema.parse(req.body);

  // 1. Same Project & Valid Device
  const device = await Device.findOne({ _id: deviceAssetId, projectId }).lean();
  if (!device) throw new ApiError(404, 'Device not found in this project');
  if (['DECOMMISSIONED', 'INACTIVE'].includes(device.status)) {
    throw new ApiError(400, 'Cannot map sensors to a decommissioned or inactive device');
  }

  // Lookup Device catalogue record for capacity & supported signal types
  const deviceCat = await DeviceCatalogue.findOne({ uid: device.device_uid || device.metadata?.device_uid }).lean();
  const maxChannels = deviceCat?.max_channels || 8;
  const supportedSignals = deviceCat?.supported_signal_types || ['vibrating_wire', 'rs485'];

  // 2. Same Project & Valid Sensors
  const sensors = await Instrument.find({
    _id: { $in: sensorAssetIds },
    projectId
  }).lean();

  if (sensors.length !== sensorAssetIds.length) {
    throw new ApiError(400, 'One or more selected sensors were not found in this project');
  }

  for (const s of sensors) {
    if (['DECOMMISSIONED', 'INACTIVE'].includes(s.status)) {
      throw new ApiError(400, `Sensor '${s.code}' is inactive/decommissioned and cannot be assigned`);
    }
  }

  // 3. Sensor Unassigned Check: One sensor may only have ONE active mapping
  const existingSensorMappings = await SensorDeviceMapping.find({
    projectId,
    sensorAssetId: { $in: sensorAssetIds },
    status: 'ACTIVE'
  }).populate('deviceAssetId', 'deviceId').lean();

  if (existingSensorMappings.length > 0) {
    const assignedCodes = sensors
      .filter(s => existingSensorMappings.some(m => m.sensorAssetId.toString() === s._id.toString()))
      .map(s => s.code);
    throw new ApiError(409, `Sensor(s) already assigned to a device: ${assignedCodes.join(', ')}`);
  }

  // 4. Device Capacity Check: max_channels
  const currentActiveOnDevice = await SensorDeviceMapping.find({
    projectId,
    deviceAssetId: device._id,
    status: 'ACTIVE'
  }).lean();

  const currentConnectedCount = currentActiveOnDevice.length;
  const requestedCount = sensorAssetIds.length;

  if (currentConnectedCount + requestedCount > maxChannels) {
    throw new ApiError(400, 
      `Device capacity exceeded for '${device.deviceId}': currently ${currentConnectedCount}/${maxChannels} connected. Cannot add ${requestedCount} sensor(s). Available capacity is ${maxChannels - currentConnectedCount}.`
    );
  }

  // 5. Signal Compatibility Check
  const sensorUids = [...new Set(sensors.map(s => s.sensor_uid || s.catalogCode).filter(Boolean))];
  const sensorCatalogues = await Sensor.find({ uid: { $in: sensorUids } }).lean();
  const sensorCatMap = new Map(sensorCatalogues.map(c => [c.uid, c]));

  for (const sensor of sensors) {
    const uid = sensor.sensor_uid || sensor.catalogCode;
    const cat = sensorCatMap.get(uid);
    const signalType = cat?.signal_type || sensor.metadata?.signal_type;

    if (signalType && !supportedSignals.includes(signalType)) {
      throw new ApiError(400, 
        `Incompatible signal type: Sensor '${sensor.code}' uses '${signalType}', but Device '${device.deviceId}' only supports [${supportedSignals.join(', ')}]`
      );
    }
  }

  // 6. Slot Allocation & Slot Uniqueness Check
  const occupiedSlots = new Set(currentActiveOnDevice.map(m => m.connection?.slot).filter(Boolean));
  const newAssignments = [];

  const isManual = slotAssignments && slotAssignments.length > 0 && autoAssignSlots !== true;
  if (isManual) {
    // Manual slot assignments
    const manualSlotSet = new Set();
    for (const sa of slotAssignments) {
      if (manualSlotSet.has(sa.slot)) {
        throw new ApiError(400, `Duplicate slot ${sa.slot} in assignment request`);
      }
      manualSlotSet.add(sa.slot);
      if (sa.slot > maxChannels || sa.slot < 1) {
        throw new ApiError(400, `Slot ${sa.slot} is out of range for device '${device.deviceId}' (1-${maxChannels})`);
      }
      if (occupiedSlots.has(sa.slot)) {
        throw new ApiError(409, `Slot ${sa.slot} on device '${device.deviceId}' is already occupied`);
      }
      newAssignments.push({ sensorAssetId: sa.sensorAssetId, slot: sa.slot });
    }
  } else {
    // Auto-assign available slots (lowest available 1..maxChannels)
    const availableSlots = [];
    for (let slot = 1; slot <= maxChannels; slot++) {
      if (!occupiedSlots.has(slot)) availableSlots.push(slot);
    }

    if (availableSlots.length < requestedCount) {
      throw new ApiError(400, `Not enough free connection slots available on device '${device.deviceId}'`);
    }

    for (let i = 0; i < sensors.length; i++) {
      newAssignments.push({
        sensorAssetId: sensors[i]._id,
        slot: availableSlots[i]
      });
    }
  }

  // 7. Atomic Creation of Mappings
  const createdMappings = [];
  for (const assign of newAssignments) {
    const mapping = await SensorDeviceMapping.create({
      organizationId: req.auth.organizationId,
      projectId,
      sensorAssetId: assign.sensorAssetId,
      deviceAssetId: device._id,
      connection: {
        mode: 'slot',
        slot: assign.slot
      },
      status: 'ACTIVE',
      mappedAt: new Date()
    });

    // Update corresponding SensorChannels so they point to the device
    await SensorChannel.updateMany(
      { instrumentId: assign.sensorAssetId },
      { $set: { deviceId: device._id } }
    );

    createdMappings.push(mapping);
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId,
    action: 'SENSORS_BULK_MAPPED_TO_DEVICE',
    resourceType: 'SensorDeviceMapping',
    resourceId: device._id,
    newState: {
      deviceId: device.deviceId,
      mappedCount: createdMappings.length,
      mappings: newAssignments.map(a => ({ sensorId: a.sensorAssetId, slot: a.slot }))
    }
  });

  res.status(201).json({
    message: `Successfully mapped ${createdMappings.length} sensor(s) to device '${device.deviceId}'`,
    deviceId: device.deviceId,
    mappings: createdMappings
  });
}));

/**
 * 9. POST /projects/:projectId/commissioning/sensor-device-mappings/unassign
 * Unassigns sensor(s) from their active device mapping without destroying historical record.
 */
router.post('/projects/:projectId/commissioning/sensor-device-mappings/unassign', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const sensorAssetIds = req.body.sensorAssetIds || (req.body.sensorAssetId ? [req.body.sensorAssetId] : []);

  if (!sensorAssetIds.length) {
    throw new ApiError(400, 'sensorAssetId or sensorAssetIds is required');
  }

  const activeMappings = await SensorDeviceMapping.find({
    projectId,
    sensorAssetId: { $in: sensorAssetIds },
    status: 'ACTIVE'
  });

  if (!activeMappings.length) {
    return res.json({ message: 'No active mappings found to unassign', unassignedCount: 0 });
  }

  const unmappedAt = new Date();
  for (const m of activeMappings) {
    m.status = 'UNASSIGNED';
    m.unmappedAt = unmappedAt;
    await m.save();
  }

  // Clear deviceId from SensorChannels
  await SensorChannel.updateMany(
    { instrumentId: { $in: sensorAssetIds } },
    { $unset: { deviceId: 1 } }
  );

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId,
    action: 'SENSORS_UNMAPPED_FROM_DEVICE',
    resourceType: 'SensorDeviceMapping',
    resourceId: req.params.projectId,
    newState: { unassignedSensorIds: sensorAssetIds }
  });

  res.json({
    message: `Successfully unassigned ${activeMappings.length} sensor(s)`,
    unassignedCount: activeMappings.length
  });
}));

/**
 * 10. POST /projects/:projectId/commissioning/device-gateway-mappings/bulk
 * Atomic bulk assignment of devices to a gateway with communication & capacity validation.
 */
const bulkDeviceGatewayMappingSchema = z.object({
  gatewayAssetId: z.string().min(1, 'Target gateway is required'),
  deviceAssetIds: z.array(z.string()).min(1, 'At least one device must be selected')
});

router.post('/projects/:projectId/commissioning/device-gateway-mappings/bulk', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const { gatewayAssetId, deviceAssetIds } = bulkDeviceGatewayMappingSchema.parse(req.body);

  // 1. Same Project & Valid Gateway
  const gateway = await ProjectGateway.findOne({ _id: gatewayAssetId, projectId }).lean();
  if (!gateway) throw new ApiError(404, 'Gateway not found in this project');
  if (['DECOMMISSIONED', 'INACTIVE'].includes(gateway.status)) {
    throw new ApiError(400, 'Cannot map devices to a decommissioned or inactive gateway');
  }

  // Lookup Gateway catalogue for capacity & supported communication protocols
  const gatewayCat = await GatewayCatalogue.findOne({ uid: gateway.gateway_uid }).lean();
  const maxDevices = gatewayCat?.max_devices || 100;
  const supportedComms = gatewayCat?.supported_device_communications || ['lorawan'];

  // 2. Same Project & Valid Devices
  const devices = await Device.find({
    _id: { $in: deviceAssetIds },
    projectId
  }).lean();

  if (devices.length !== deviceAssetIds.length) {
    throw new ApiError(400, 'One or more selected devices were not found in this project');
  }

  for (const d of devices) {
    if (['DECOMMISSIONED', 'INACTIVE'].includes(d.status)) {
      throw new ApiError(400, `Device '${d.deviceId}' is inactive/decommissioned and cannot be assigned`);
    }
  }

  // 3. Device Unassigned Check
  const existingDeviceMappings = await DeviceGatewayMapping.find({
    projectId,
    deviceAssetId: { $in: deviceAssetIds },
    status: 'ACTIVE'
  }).populate('gatewayAssetId', 'gatewayId').lean();

  if (existingDeviceMappings.length > 0) {
    const conflictDeviceIds = devices
      .filter(d => existingDeviceMappings.some(m => m.deviceAssetId.toString() === d._id.toString()))
      .map(d => d.deviceId);
    throw new ApiError(409, `Device(s) already assigned to a gateway: ${conflictDeviceIds.join(', ')}`);
  }

  // 4. Gateway Capacity Check
  const currentActiveOnGateway = await DeviceGatewayMapping.countDocuments({
    projectId,
    gatewayAssetId: gateway._id,
    status: 'ACTIVE'
  });

  const requestedCount = deviceAssetIds.length;
  if (currentActiveOnGateway + requestedCount > maxDevices) {
    throw new ApiError(400, 
      `Gateway capacity exceeded for '${gateway.gatewayId}': currently ${currentActiveOnGateway}/${maxDevices} mapped. Cannot add ${requestedCount} device(s). Maximum available is ${maxDevices - currentActiveOnGateway}.`
    );
  }

  // 5. Communication Compatibility Check
  const deviceUids = [...new Set(devices.map(d => d.device_uid || d.metadata?.device_uid).filter(Boolean))];
  const deviceCatalogues = await DeviceCatalogue.find({ uid: { $in: deviceUids } }).lean();
  const deviceCatMap = new Map(deviceCatalogues.map(c => [c.uid, c]));

  for (const dev of devices) {
    const uid = dev.device_uid || dev.metadata?.device_uid;
    const cat = deviceCatMap.get(uid);
    const comm = cat?.communication || (dev.transport === 'LORAWAN' ? 'lorawan' : '4g');

    if (comm && !supportedComms.includes(comm)) {
      throw new ApiError(400, 
        `Incompatible communication: Device '${dev.deviceId}' uses '${comm}', but Gateway '${gateway.gatewayId}' only supports [${supportedComms.join(', ')}]`
      );
    }
  }

  // 6. Atomic Creation of Mappings
  const createdMappings = [];
  for (const dev of devices) {
    const mapping = await DeviceGatewayMapping.create({
      organizationId: req.auth.organizationId,
      projectId,
      deviceAssetId: dev._id,
      gatewayAssetId: gateway._id,
      status: 'ACTIVE',
      mappedAt: new Date()
    });
    createdMappings.push(mapping);
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId,
    action: 'DEVICES_BULK_MAPPED_TO_GATEWAY',
    resourceType: 'DeviceGatewayMapping',
    resourceId: gateway._id,
    newState: {
      gatewayId: gateway.gatewayId,
      mappedDeviceCount: createdMappings.length,
      deviceIds: devices.map(d => d.deviceId)
    }
  });

  res.status(201).json({
    message: `Successfully mapped ${createdMappings.length} device(s) to gateway '${gateway.gatewayId}'`,
    gatewayId: gateway.gatewayId,
    mappings: createdMappings
  });
}));

/**
 * 11. POST /projects/:projectId/commissioning/device-gateway-mappings/unassign
 * Unassigns device(s) from their active gateway mapping.
 */
router.post('/projects/:projectId/commissioning/device-gateway-mappings/unassign', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const deviceAssetIds = req.body.deviceAssetIds || (req.body.deviceAssetId ? [req.body.deviceAssetId] : []);

  if (!deviceAssetIds.length) {
    throw new ApiError(400, 'deviceAssetId or deviceAssetIds is required');
  }

  const activeMappings = await DeviceGatewayMapping.find({
    projectId,
    deviceAssetId: { $in: deviceAssetIds },
    status: 'ACTIVE'
  });

  if (!activeMappings.length) {
    return res.json({ message: 'No active mappings found to unassign', unassignedCount: 0 });
  }

  const unmappedAt = new Date();
  for (const m of activeMappings) {
    m.status = 'UNASSIGNED';
    m.unmappedAt = unmappedAt;
    await m.save();
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId,
    action: 'DEVICES_UNMAPPED_FROM_GATEWAY',
    resourceType: 'DeviceGatewayMapping',
    resourceId: req.params.projectId,
    newState: { unassignedDeviceIds: deviceAssetIds }
  });

  res.json({
    message: `Successfully unassigned ${activeMappings.length} device(s) from gateway`,
    unassignedCount: activeMappings.length
  });
}));

/**
 * 10. GET /projects/:projectId/commissioning/sensors/:instrumentId/setup
 * Returns complete setup context for an existing registered Sensor (Instrument)
 */
router.get('/projects/:projectId/commissioning/sensors/:instrumentId/setup', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId: rawProjectId, instrumentId } = req.params;
  const project = await resolveProject(rawProjectId);
  const resolvedProjectId = project._id;

  // Resolve instrument by ObjectId or code/deviceId/serial/name
  const idOrCode = [
    { code: instrumentId },
    { code: new RegExp(`^${instrumentId}$`, 'i') },
    { deviceId: instrumentId },
    { serial: instrumentId },
    { name: instrumentId }
  ];
  if (mongoose.Types.ObjectId.isValid(instrumentId)) {
    idOrCode.unshift({ _id: instrumentId });
  }

  const instrument = await Instrument.findOne({
    projectId: resolvedProjectId,
    $or: idOrCode
  }).lean();
  if (!instrument) throw new ApiError(404, 'Sensor not found');

  const sensorLookup = [
    instrument.sensor_uid ? { uid: instrument.sensor_uid } : null,
    instrument.catalogCode ? { uid: instrument.catalogCode } : null,
    instrument.catalogCode ? { code: instrument.catalogCode } : null,
    instrument.name ? { name: instrument.name } : null
  ].filter(Boolean);

  const [channels, mapping, sensorCat] = await Promise.all([
    SensorChannel.find({ instrumentId: instrument._id }).lean(),
    SensorDeviceMapping.findOne({ projectId: resolvedProjectId, sensorAssetId: instrument._id, status: 'ACTIVE' })
      .populate('deviceAssetId', 'deviceId name device_uid transport status')
      .lean(),
    sensorLookup.length > 0 ? Sensor.findOne({ $or: sensorLookup }).lean() : Promise.resolve(null)
  ]);

  let deviceCat = null;
  if (mapping?.deviceAssetId?.device_uid) {
    deviceCat = await DeviceCatalogue.findOne({ uid: mapping.deviceAssetId.device_uid }).lean();
  }

  res.json({
    instrument,
    catalogue: sensorCat || { name: instrument.name, model: instrument.metadata?.model, signal_type: instrument.metadata?.signal_type, channels: [] },
    channels,
    mapping: mapping ? {
      _id: mapping._id,
      device: mapping.deviceAssetId ? {
        _id: mapping.deviceAssetId._id,
        deviceId: mapping.deviceAssetId.deviceId,
        name: mapping.deviceAssetId.name,
        model: deviceCat?.name || deviceCat?.model || '—',
        transport: mapping.deviceAssetId.transport,
        status: mapping.deviceAssetId.status
      } : null,
      connection: mapping.connection,
      mappedAt: mapping.mappedAt
    } : null
  });
}));

/**
 * 11. PUT /projects/:projectId/commissioning/sensors/:instrumentId/setup
 * Updates installation, engineering parameters, channels, calibration, baseline and lifecycle for an existing Sensor.
 * Operates on the SAME Instrument record — never creates duplicate assets.
 */
router.put('/projects/:projectId/commissioning/sensors/:instrumentId/setup', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId: rawProjectId, instrumentId } = req.params;
  const project = await resolveProject(rawProjectId);
  const resolvedProjectId = project._id;

  // Resolve instrument by ObjectId or code/deviceId/serial/name
  const idOrCode = [
    { code: instrumentId },
    { code: new RegExp(`^${instrumentId}$`, 'i') },
    { deviceId: instrumentId },
    { serial: instrumentId },
    { name: instrumentId }
  ];
  if (mongoose.Types.ObjectId.isValid(instrumentId)) {
    idOrCode.unshift({ _id: instrumentId });
  }

  const instrument = await Instrument.findOne({
    projectId: resolvedProjectId,
    $or: idOrCode
  });
  if (!instrument) throw new ApiError(404, 'Sensor not found');

  const {
    siteId,
    zoneId,
    coordinates,
    depthM,
    orientationDeg,
    serial,
    calibrationSource,
    calibrationConfigured,
    baselineMode,
    baselineConfigured,
    channels = [],
    commission = false
  } = req.body;

  if (siteId !== undefined) instrument.siteId = siteId || undefined;
  if (zoneId !== undefined) instrument.zoneId = zoneId || undefined;
  if (coordinates !== undefined) instrument.coordinates = coordinates;
  if (depthM !== undefined) instrument.depthM = depthM;
  if (orientationDeg !== undefined) instrument.orientationDeg = orientationDeg;
  if (serial !== undefined && serial) instrument.serial = serial;

  if (!instrument.metadata) instrument.metadata = {};
  if (calibrationSource !== undefined) instrument.metadata.calibrationSource = calibrationSource;
  if (calibrationConfigured !== undefined) instrument.metadata.calibrationConfigured = calibrationConfigured;
  if (baselineMode !== undefined) instrument.metadata.baselineMode = baselineMode;
  if (baselineConfigured !== undefined) instrument.metadata.baselineConfigured = baselineConfigured;
  instrument.markModified('metadata');

  if (commission) {
    // 1. Site selected validation
    if (!siteId && !instrument.siteId) {
      throw new ApiError(400, 'Cannot commission sensor: A Site / Structure must be selected.');
    }

    // 2. Measurement channels validation
    const enabledChannels = channels.filter(c => c.enabled !== false);
    if (enabledChannels.length === 0) {
      throw new ApiError(400, 'Cannot commission sensor: At least one measurement channel must be enabled.');
    }

    // 3. Active SensorDeviceMapping validation
    const activeMapping = await SensorDeviceMapping.findOne({
      projectId: resolvedProjectId,
      sensorAssetId: instrument._id,
      status: 'ACTIVE'
    });
    if (!activeMapping) {
      throw new ApiError(400, 'Cannot commission sensor: Sensor must be mapped to an active Logger Device.');
    }

    // 4. Calibration validation
    const isCalibDone = calibrationConfigured === true || 
      (channels.length > 0 && channels.every(c => c.calibration?.configured));
    if (!isCalibDone && !instrument.metadata?.calibrationConfigured) {
      throw new ApiError(400, 'Cannot commission sensor: Calibration source and parameters must be explicitly configured.');
    }

    // 5. Baseline validation
    const isBaselineDone = baselineConfigured === true || 
      (channels.length > 0 && channels.every(c => c.baseline?.configured));
    if (!isBaselineDone && !instrument.metadata?.baselineConfigured) {
      throw new ApiError(400, 'Cannot commission sensor: Baseline reference must be explicitly configured.');
    }

    instrument.status = 'COMMISSIONED';
    instrument.commissionedAt = new Date();
    instrument.commissionedBy = req.auth.userId;
  } else if (instrument.status !== 'COMMISSIONED') {
    instrument.status = 'SETUP_IN_PROGRESS';
  }

  await instrument.save();

  // Upsert channels for this instrument
  const savedChannels = [];
  for (const ch of channels) {
    if (!ch.code) continue;
    let channelDoc = await SensorChannel.findOne({ instrumentId: instrument._id, code: ch.code });
    if (!channelDoc) {
      channelDoc = new SensorChannel({
        organizationId: instrument.organizationId,
        projectId: instrument.projectId,
        instrumentId: instrument._id,
        code: ch.code
      });
    }

    if (ch.parameterCode) channelDoc.parameterCode = ch.parameterCode;
    if (ch.rawUnit !== undefined) channelDoc.rawUnit = ch.rawUnit;
    if (ch.engineeringUnit !== undefined) channelDoc.engineeringUnit = ch.engineeringUnit;
    if (ch.sampleIntervalSec !== undefined) channelDoc.sampleIntervalSec = ch.sampleIntervalSec;
    if (ch.enabled !== undefined) channelDoc.enabled = ch.enabled;
    if (ch.calibration) channelDoc.calibration = ch.calibration;
    if (ch.baseline) channelDoc.baseline = ch.baseline;

    await channelDoc.save();
    savedChannels.push(channelDoc);
  }

  await audit({
    req,
    organizationId: req.auth.organizationId,
    projectId: resolvedProjectId,
    action: commission ? 'INSTRUMENT_COMMISSIONED' : 'INSTRUMENT_SETUP_UPDATED',
    resourceType: 'Instrument',
    resourceId: instrument._id,
    newState: { instrument: instrument.toObject(), channelsCount: savedChannels.length }
  });

  res.json({
    message: commission ? 'Sensor successfully commissioned' : 'Sensor setup saved successfully',
    instrument,
    channels: savedChannels
  });
}));

export default router;
