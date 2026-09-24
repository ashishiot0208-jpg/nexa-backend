import { Router } from 'express';
import {
  Project,
  Site,
  Zone,
  Instrument,
  Device,
  CameraSource,
  GeospatialLayer,
  GeospatialFeature
} from '../models/index.js';
import { requireAuth, requireProjectAccess, requireOrgRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from '../services/audit.service.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get('/projects/:projectId/geospatial', requireProjectAccess, asyncHandler(async (req, res) => {
  const { projectId } = req.params;

  const project = await Project.findById(projectId).lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const [sites, zones, layers, features, instruments, devices, cameras] = await Promise.all([
    Site.find({ projectId }).sort({ level: 1, name: 1 }).lean(),
    Zone.find({ projectId }).sort({ name: 1 }).lean(),
    GeospatialLayer.find({ projectId }).sort({ createdAt: -1 }).lean(),
    GeospatialFeature.find({ projectId }).lean(),
    Instrument.find({ projectId, status: { $ne: 'DELETED' } }).sort({ code: 1 }).lean(),
    Device.find({ projectId, status: { $ne: 'DELETED' } }).sort({ deviceId: 1 }).lean(),
    CameraSource.find({ projectId }).sort({ name: 1 }).lean()
  ]);

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

export default router;
