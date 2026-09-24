import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const geospatialLayerSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  geometryType: { type: String },
  sourceType: { type: String, enum: ['KML', 'GEOJSON'], default: 'GEOJSON' },
  sourceFile: String,
  coordinateReferenceSystem: { type: String, default: 'EPSG:4326' },
  style: { type: Schema.Types.Mixed, default: {} },
  metadata: { type: Schema.Types.Mixed, default: {} },
  version: { type: Number, default: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

const geospatialFeatureSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  layerId: { type: Schema.Types.ObjectId, ref: 'GeospatialLayer', required: true, index: true },
  featureKey: String,
  name: String,
  category: String,
  geometry: { type: Schema.Types.Mixed, required: true },
  properties: { type: Schema.Types.Mixed, default: {} },
  style: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

export const GeospatialLayer = model('GeospatialLayer', geospatialLayerSchema);
export const GeospatialFeature = model('GeospatialFeature', geospatialFeatureSchema);
