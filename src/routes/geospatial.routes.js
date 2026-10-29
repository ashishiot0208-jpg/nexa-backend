import { Router } from 'express';
import {
  Project,
  Site,
  Zone,
  Instrument,
  Device,
  CameraSource,
  GeospatialLayer,
  GeospatialFeature,
  ProjectGateway,
  DeviceCatalogue,
  GatewayCatalogue,
  SensorDeviceMapping,
  DeviceGatewayMapping
} from '../models/index.js';
import { requireAuth, requireProjectAccess, requireOrgRole, requireProjectPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from '../services/audit.service.js';
import { getInstrumentOperationalSummary, getProjectOperationalSummaries } from '../services/instrument-summary.service.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get('/projects/:projectId/geospatial', requireProjectAccess, requireProjectPermission('map.view'), asyncHandler(async (req, res) => {
  console.log('[GEO] 1 route entered');
  const timer = setTimeout(() => {
    console.error('[GEO] request exceeded 10 seconds');
  }, 10000);

  const { projectId } = req.params;

  const project = await Project.findById(projectId).lean();
  if (!project) {
    clearTimeout(timer);
    throw new ApiError(404, 'Project not found');
  }
  console.log('[GEO] 2 project access confirmed');

  // Split Promise.all for diagnosis
  const sites = await Site.find({ projectId }).sort({ level: 1, name: 1 }).lean();
  console.log('[GEO] 3 sites loaded', sites.length);

  const zones = await Zone.find({ projectId }).sort({ name: 1 }).lean();
  console.log('[GEO] 4 zones loaded', zones.length);

  const layers = await GeospatialLayer.find({ projectId }).sort({ createdAt: -1 }).lean();
  console.log('[GEO] 5 layers loaded', layers.length);

  const features = await GeospatialFeature.find({ projectId }).lean();
  console.log('[GEO] 6 features loaded', features.length);

  const instruments = await Instrument.find({ projectId, status: { $ne: 'DELETED' } }).sort({ code: 1 }).lean();
  console.log('[GEO] 7 instruments loaded', instruments.length);

  const devices = await Device.find({ projectId, status: { $ne: 'DELETED' } }).sort({ deviceId: 1 }).lean();
  console.log('[GEO] 8 devices loaded', devices.length);

  const cameras = await CameraSource.find({ projectId }).sort({ name: 1 }).lean();
  console.log('[GEO] 9 cameras loaded', cameras.length);
  
  console.log('[GEO] 10 sending response');
  clearTimeout(timer);

  res.json({
    project: {
      id: project._id,
      name: project.name,
      code: project.code,
      useCaseCode: project.useCaseCode,
      location: project.location,
      coordinateSystem: project.coordinateSystem || 'EPSG:4326'
    },
    sites: sites.map(s => ({
      id: s._id,
      name: s.name,
      code: s.code,
      type: s.type,
      parentId: s.parentId,
      level: s.level,
      geometry: s.geometry,
      mapExtent: s.mapExtent
    })),
    zones: zones.map(z => ({
      id: z._id,
      name: z.name,
      code: z.code,
      type: z.type,
      siteId: z.siteId,
      geometry: z.geometry
    })),
    layers: layers.map(l => ({
      id: l._id,
      name: l.name,
      category: l.category,
      geometryType: l.geometryType,
      sourceType: l.sourceType,
      sourceFile: l.sourceFile,
      coordinateReferenceSystem: l.coordinateReferenceSystem,
      style: l.style,
      metadata: l.metadata,
      version: l.version,
      createdAt: l.createdAt
    })),
    features: features.map(f => ({
      id: f._id,
      layerId: f.layerId,
      featureKey: f.featureKey,
      name: f.name,
      category: f.category,
      geometry: f.geometry,
      properties: f.properties,
      style: f.style
    })),
    monitoring: {
      instruments: instruments.map(i => ({
        id: i._id,
        code: i.code,
        name: i.name,
        catalogCode: i.catalogCode,
        siteId: i.siteId,
        zoneId: i.zoneId,
        coordinates: i.coordinates,
        orientationDeg: i.orientationDeg,
        status: i.status,
        metadata: i.metadata || {}
      })),
      devices: devices.map(d => ({
        id: d._id,
        deviceId: d.deviceId,
        name: d.name,
        deviceType: d.deviceType,
        status: d.status,
        healthGrade: d.healthGrade,
        lastSeenAt: d.lastSeenAt,
        coordinates: d.metadata?.coordinates
      })),
      cameras: cameras.map(c => ({
        id: c._id,
        name: c.name,
        siteId: c.siteId,
        zoneId: c.zoneId,
        healthState: c.healthState,
        lastImageAt: c.lastImageAt,
        coordinates: c.metadata?.coordinates
      }))
    }
  });
}));

router.get('/projects/:projectId/map/instruments', requireProjectAccess, requireProjectPermission('map.view'), asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const organizationId = req.auth.organizationId;

  const project = await Project.findOne({ _id: projectId, organizationId }).lean();
  if (!project) {
    throw new ApiError(404, 'Project not found');
  }

  const summaries = await getProjectOperationalSummaries(projectId, organizationId);

  const markers = summaries.filter(Boolean).map(s => {
    const coords = (Array.isArray(s.instrument?.coordinates) && s.instrument.coordinates.length >= 2)
      ? s.instrument.coordinates
      : (s.location?.longitude != null && s.location?.latitude != null
        ? [s.location.longitude, s.location.latitude]
        : null);

    return {
      id: s.instrument._id,
      code: s.instrument.code,
      name: s.instrument.name,
      typeName: s.instrument.typeName,
      catalogCode: s.instrument.catalogCode,
      siteId: s.instrument.siteId,
      siteName: s.location?.siteName || '—',
      zoneId: s.instrument.zoneId,
      zoneName: s.location?.zoneName || '—',
      coordinates: coords,
      orientationDeg: s.location?.orientationDeg ?? s.instrument?.orientationDeg,
      status: s.instrument.status,
      displayChannel: s.displayChannel,
      latestValue: s.latest?.engineeringValue ?? null,
      rawReadingValue: s.latest?.rawValue ?? null,
      unit: s.latest?.unit || '',
      channelLabel: s.latest?.channelLabel || '',
      deltaFromBaseline: s.latest?.deltaFromBaseline ?? null,
      severity: s.operational?.severity || 'NOT EVALUATED',
      health: s.operational?.health || 'NOT EVALUATED',
      quality: s.operational?.quality || 'NOT EVALUATED',
      confidence: s.operational?.confidence ?? null,
      rate: s.operational?.rate ?? null,
      lastSample: s.latest?.timestamp ?? null,
      device: s.connection?.device ? {
        id: s.connection.device.id,
        deviceId: s.connection.device.deviceId,
        name: s.connection.device.name,
        status: s.connection.device.status,
        runtimeStatus: s.connection.device.runtimeStatus,
        lastSeenAt: s.connection.device.lastSeenAt,
        healthGrade: s.connection.device.healthGrade
      } : null,
      gateway: s.connection?.gateway ? {
        id: s.connection.gateway.id,
        gatewayId: s.connection.gateway.gatewayId,
        name: s.connection.gateway.name,
        status: s.connection.gateway.status,
        runtimeStatus: s.connection.gateway.runtimeStatus,
        lastSeenAt: s.connection.gateway.lastSeenAt
      } : null
    };
  });

  res.json(markers);
}));

router.get('/projects/:projectId/map/assets', requireProjectAccess, requireProjectPermission('map.view'), asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const organizationId = req.auth.organizationId;

  const project = await Project.findOne({ _id: projectId, organizationId }).lean();
  if (!project) {
    throw new ApiError(404, 'Project not found');
  }

  // 1. Bulk-load instruments via existing optimized getProjectOperationalSummaries
  const summaries = await getProjectOperationalSummaries(projectId, organizationId);
  const instruments = summaries.filter(Boolean).map(s => {
    const coords = (Array.isArray(s.instrument?.coordinates) && s.instrument.coordinates.length >= 2 && Number.isFinite(s.instrument.coordinates[0]) && Number.isFinite(s.instrument.coordinates[1]) && !(s.instrument.coordinates[0] === 0 && s.instrument.coordinates[1] === 0))
      ? s.instrument.coordinates
      : (s.location?.longitude != null && s.location?.latitude != null && Number.isFinite(s.location.longitude) && Number.isFinite(s.location.latitude) && !(s.location.longitude === 0 && s.location.latitude === 0)
        ? [s.location.longitude, s.location.latitude]
        : null);

    return {
      id: s.instrument._id,
      code: s.instrument.code,
      name: s.instrument.name,
      typeName: s.instrument.typeName,
      catalogCode: s.instrument.catalogCode,
      siteId: s.instrument.siteId,
      siteName: s.location?.siteName || '—',
      zoneId: s.instrument.zoneId,
      zoneName: s.location?.zoneName || '—',
      coordinates: coords,
      orientationDeg: s.location?.orientationDeg ?? s.instrument?.orientationDeg,
      status: s.instrument.status,
      displayChannel: s.displayChannel,
      latestValue: s.latest?.engineeringValue ?? null,
      rawReadingValue: s.latest?.rawValue ?? null,
      unit: s.latest?.unit || '',
      channelLabel: s.latest?.channelLabel || '',
      deltaFromBaseline: s.latest?.deltaFromBaseline ?? null,
      severity: s.operational?.severity || 'NOT EVALUATED',
      health: s.operational?.health || 'NOT EVALUATED',
      quality: s.operational?.quality || 'NOT EVALUATED',
      confidence: s.operational?.confidence ?? null,
      rate: s.operational?.rate ?? null,
      lastSample: s.latest?.timestamp ?? null,
      device: s.connection?.device ? {
        id: s.connection.device.id,
        deviceId: s.connection.device.deviceId,
        name: s.connection.device.name,
        status: s.connection.device.status,
        runtimeStatus: s.connection.device.runtimeStatus,
        lastSeenAt: s.connection.device.lastSeenAt,
        healthGrade: s.connection.device.healthGrade
      } : null,
      gateway: s.connection?.gateway ? {
        id: s.connection.gateway.id,
        gatewayId: s.connection.gateway.gatewayId,
        name: s.connection.gateway.name,
        status: s.connection.gateway.status,
        runtimeStatus: s.connection.gateway.runtimeStatus,
        lastSeenAt: s.connection.gateway.lastSeenAt
      } : null
    };
  });

  // 2. Bulk-load devices, gateways, catalogues, mappings, sites, zones
  const [
    rawDevices,
    rawGateways,
    sdms,
    dgms,
    sites,
    zones
  ] = await Promise.all([
    Device.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).sort({ deviceId: 1 }).lean(),
    ProjectGateway.find({ projectId, status: { $ne: 'DECOMMISSIONED' } }).sort({ gatewayId: 1 }).lean(),
    SensorDeviceMapping.find({ projectId, status: 'ACTIVE' }).populate('sensorAssetId', 'code name type model').lean(),
    DeviceGatewayMapping.find({ projectId, status: 'ACTIVE' }).populate('deviceAssetId', 'deviceId name model deviceType transport').populate('gatewayAssetId', 'gatewayId name model activeBackhaul').lean(),
    Site.find({ projectId }).lean(),
    Zone.find({ projectId }).lean()
  ]);

  const devUids = [...new Set(rawDevices.map(d => d.device_uid || d.metadata?.device_uid).filter(Boolean))];
  const gwUids = [...new Set(rawGateways.map(g => g.gateway_uid).filter(Boolean))];
  const [dCats, gCats] = await Promise.all([
    DeviceCatalogue.find({ uid: { $in: devUids } }).lean(),
    GatewayCatalogue.find({ uid: { $in: gwUids } }).lean()
  ]);

  const dCatMap = new Map(dCats.map(c => [c.uid, c]));
  const gCatMap = new Map(gCats.map(c => [c.uid, c]));
  const siteMap = new Map(sites.map(s => [String(s._id), s.name]));
  const zoneMap = new Map(zones.map(z => [String(z._id), z.name]));

  // Device-level mapping maps
  const sdmCountByDevice = new Map();
  const sdmCodesByDevice = new Map();
  for (const s of sdms) {
    const dId = String(s.deviceAssetId);
    sdmCountByDevice.set(dId, (sdmCountByDevice.get(dId) || 0) + 1);
    if (!sdmCodesByDevice.has(dId)) sdmCodesByDevice.set(dId, []);
    if (s.sensorAssetId?.code) sdmCodesByDevice.get(dId).push(s.sensorAssetId.code);
  }

  const dgmByDevice = new Map();
  const dgmCountByGateway = new Map();
  const dgmCodesByGateway = new Map();
  for (const dg of dgms) {
    const dId = String(dg.deviceAssetId?._id || dg.deviceAssetId);
    const gId = String(dg.gatewayAssetId?._id || dg.gatewayAssetId);
    if (dg.gatewayAssetId) {
      dgmByDevice.set(dId, {
        id: dg.gatewayAssetId._id,
        gatewayId: dg.gatewayAssetId.gatewayId,
        name: dg.gatewayAssetId.name
      });
    }
    dgmCountByGateway.set(gId, (dgmCountByGateway.get(gId) || 0) + 1);
    if (!dgmCodesByGateway.has(gId)) dgmCodesByGateway.set(gId, []);
    if (dg.deviceAssetId?.deviceId) dgmCodesByGateway.get(gId).push(dg.deviceAssetId.deviceId);
  }

  const now = Date.now();

  const devices = rawDevices.map(d => {
    const cat = dCatMap.get(d.device_uid || d.metadata?.device_uid) || {};
    const dId = String(d._id);
    const coords = (Array.isArray(d.coordinates) && d.coordinates.length >= 2 && Number.isFinite(d.coordinates[0]) && Number.isFinite(d.coordinates[1]) && !(d.coordinates[0] === 0 && d.coordinates[1] === 0))
      ? [d.coordinates[0], d.coordinates[1]]
      : null;

    let runtimeStatus = 'UNKNOWN';
    if (d.lastSeenAt) {
      const ageMs = now - new Date(d.lastSeenAt).getTime();
      const intervalMs = Math.max(60, d.expectedIntervalSec || 900) * 1000;
      if (ageMs <= intervalMs * 2) runtimeStatus = 'ONLINE';
      else if (ageMs <= intervalMs * 6) runtimeStatus = 'STALE';
      else runtimeStatus = 'OFFLINE';
    } else if (d.runtimeStatus) {
      runtimeStatus = d.runtimeStatus;
    }

    const assignedGw = dgmByDevice.get(dId) || null;

    return {
      id: d._id,
      deviceId: d.deviceId,
      name: d.name,
      model: cat.model || d.model || '—',
      deviceType: cat.name || d.deviceType || 'Sensor Node',
      coordinates: coords,
      siteId: d.siteId,
      siteName: siteMap.get(String(d.siteId)) || '—',
      zoneId: d.zoneId,
      zoneName: zoneMap.get(String(d.zoneId)) || '—',
      status: d.status,
      runtimeStatus,
      transport: d.transport || (cat.communication === '4g' ? '4G LTE' : 'LoRaWAN'),
      firmware: d.firmware || null,
      lastSeenAt: d.lastSeenAt || null,
      connectedSensorsCount: sdmCountByDevice.get(dId) || 0,
      maxChannels: cat.max_channels || 8,
      connectedSensorCodes: sdmCodesByDevice.get(dId) || [],
      gateway: assignedGw
    };
  });

  const gateways = rawGateways.map(g => {
    const cat = gCatMap.get(g.gateway_uid) || {};
    const gId = String(g._id);
    const coords = (Array.isArray(g.coordinates) && g.coordinates.length >= 2 && Number.isFinite(g.coordinates[0]) && Number.isFinite(g.coordinates[1]) && !(g.coordinates[0] === 0 && g.coordinates[1] === 0))
      ? [g.coordinates[0], g.coordinates[1]]
      : null;

    const lastSeenAt = g.metadata?.lastSeenAt || null;
    let runtimeStatus = 'UNKNOWN';
    if (lastSeenAt) {
      const ageMs = now - new Date(lastSeenAt).getTime();
      const intervalMs = 1800 * 1000;
      if (ageMs <= intervalMs * 2) runtimeStatus = 'ONLINE';
      else if (ageMs <= intervalMs * 6) runtimeStatus = 'STALE';
      else runtimeStatus = 'OFFLINE';
    }

    const backhaulStr = g.activeBackhaul || cat.backhaul?.[0] || 'Ethernet';
    const backhaul = backhaulStr.toLowerCase() === 'ethernet'
      ? 'Ethernet'
      : (backhaulStr.toLowerCase() === '4g' || backhaulStr.toLowerCase() === 'cellular' ? '4G LTE' : (backhaulStr.charAt(0).toUpperCase() + backhaulStr.slice(1)));

    return {
      id: g._id,
      gatewayId: g.gatewayId,
      name: g.name,
      model: cat.model || g.model || '—',
      coordinates: coords,
      siteId: g.siteId,
      siteName: siteMap.get(String(g.siteId)) || '—',
      zoneId: g.zoneId,
      zoneName: zoneMap.get(String(g.zoneId)) || '—',
      status: g.status,
      runtimeStatus,
      backhaul,
      firmware: g.metadata?.firmware || null,
      lastSeenAt,
      devicesRoutedCount: dgmCountByGateway.get(gId) || 0,
      maxDevices: cat.max_devices || 100,
      mappedDeviceCodes: dgmCodesByGateway.get(gId) || []
    };
  });

  const instPos = instruments.filter(i => Array.isArray(i.coordinates) && i.coordinates.length >= 2).length;
  const devPos = devices.filter(d => Array.isArray(d.coordinates) && d.coordinates.length >= 2).length;
  const gwPos = gateways.filter(g => Array.isArray(g.coordinates) && g.coordinates.length >= 2).length;

  res.json({
    instruments,
    devices,
    gateways,
    counts: {
      instruments: {
        total: instruments.length,
        positioned: instPos,
        unpositioned: instruments.length - instPos
      },
      devices: {
        total: devices.length,
        positioned: devPos,
        unpositioned: devices.length - devPos
      },
      gateways: {
        total: gateways.length,
        positioned: gwPos,
        unpositioned: gateways.length - gwPos
      }
    }
  });
}));

function sanitizeKeys(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val.map(sanitizeKeys);
  }
  if (typeof val === 'object' && val.constructor === Object) {
    const clean = {};
    for (const [key, value] of Object.entries(val)) {
      const safeKey = String(key).replace(/\./g, '_').replace(/^\$/, '_$');
      clean[safeKey] = sanitizeKeys(value);
    }
    return clean;
  }
  return val;
}

router.post('/projects/:projectId/geospatial/import', requireProjectAccess, requireOrgRole('ADMINISTRATOR', 'ENGINEER'), asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const { name, category, sourceType, sourceFile, features } = req.body;

  if (!name || typeof name !== 'string') {
    throw new ApiError(400, 'Layer name is required');
  }
  if (!category || typeof category !== 'string') {
    throw new ApiError(400, 'Classification category is required');
  }
  if (!Array.isArray(features) || features.length < 1) {
    throw new ApiError(400, 'Features array must contain at least 1 feature');
  }
  if (features.length > 500) {
    throw new ApiError(400, 'Maximum 500 features per import');
  }

  const project = await Project.findById(projectId).lean();
  if (!project) throw new ApiError(404, 'Project not found');
  const orgId = req.auth?.organizationId || project.organizationId;

  const layer = await GeospatialLayer.create({
    organizationId: orgId,
    projectId,
    name,
    category,
    sourceType: sourceType === 'KML' ? 'KML' : 'GEOJSON',
    sourceFile: sourceFile || '',
    coordinateReferenceSystem: 'EPSG:4326',
    createdBy: req.auth?.userId || req.auth?.id || null
  });

  const featureDocs = features.map((f, idx) => ({
    organizationId: orgId,
    projectId,
    layerId: layer._id,
    featureKey: f.properties?.id || f.properties?.name || `feature-${idx + 1}`,
    name: f.properties?.name || f.properties?.title || `${name} #${idx + 1}`,
    category,
    geometry: f.geometry,
    properties: sanitizeKeys(f.properties || {}),
    style: sanitizeKeys(f.properties?.style || {})
  }));

  await GeospatialFeature.insertMany(featureDocs);

  try {
    await audit({
      req,
      projectId,
      action: 'PROJECT_GEOMETRY_IMPORTED',
      resourceType: 'GeospatialLayer',
      resourceId: layer._id,
      newState: { layerId: layer._id, featureCount: featureDocs.length, category }
    });
  } catch (auditErr) {
    console.warn('Audit log write failed during geometry import:', auditErr);
  }

  res.status(201).json({
    ok: true,
    layerId: layer._id,
    featureCount: featureDocs.length
  });
}));

router.delete([
  '/projects/:projectId/geospatial/:layerId',
  '/projects/:projectId/geospatial/layers/:layerId'
], requireProjectAccess, requireOrgRole('ADMINISTRATOR', 'ENGINEER'), asyncHandler(async (req, res) => {
  const { projectId, layerId } = req.params;
  const orgId = req.auth?.organizationId;

  const project = await Project.findOne({
    _id: projectId,
    ...(orgId ? { organizationId: orgId } : {})
  }).lean();

  if (!project) {
    throw new ApiError(404, 'Project not found');
  }

  const layer = await GeospatialLayer.findOne({
    _id: layerId,
    projectId: project._id,
    ...(orgId ? { organizationId: orgId } : {})
  });

  if (!layer) {
    throw new ApiError(404, 'Geospatial layer not found');
  }

  // Delete all features belonging to this layer
  const featureDeleteResult = await GeospatialFeature.deleteMany({
    layerId: layer._id,
    projectId: project._id,
    ...(orgId ? { organizationId: orgId } : {})
  });

  // Delete the layer document itself
  await GeospatialLayer.deleteOne({
    _id: layer._id,
    projectId: project._id,
    ...(orgId ? { organizationId: orgId } : {})
  });

  try {
    await audit({
      req,
      projectId: project._id,
      action: 'PROJECT_GEOMETRY_DELETED',
      resourceType: 'GeospatialLayer',
      resourceId: layer._id,
      previousState: {
        layerId: layer._id,
        name: layer.name,
        category: layer.category,
        featuresDeleted: featureDeleteResult.deletedCount
      }
    });
  } catch (auditErr) {
    console.warn('Audit log write failed during geometry layer deletion:', auditErr);
  }

  res.json({
    ok: true,
    message: 'Geometry layer removed',
    layerId: layer._id,
    featuresDeleted: featureDeleteResult.deletedCount
  });
}));

export default router;
