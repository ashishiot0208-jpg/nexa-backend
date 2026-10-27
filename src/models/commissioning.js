import mongoose from 'mongoose';
const { Schema, model } = mongoose;

/**
 * ProjectGateway Model
 * Represents an actual physical Gateway installed/registered for a project.
 */
const projectGatewaySchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  gatewayId: { type: String, required: true }, // e.g. GW-DAM-01
  name: { type: String, required: true },
  model: { type: String, default: '' },
  gateway_uid: { type: String, required: true }, // references GatewayCatalogue.uid e.g. GW000001
  serial: { type: String, default: '' },
  siteId: { type: String, default: '' },
  zoneId: { type: String, default: '' },
  coordinates: { type: [Number] }, // [longitude, latitude]
  gatewayEui: { type: String, default: '' },
  activeBackhaul: { type: String, default: 'ethernet' }, // 'ethernet' | '4g'
  imei: { type: String, default: '' },
  macAddress: { type: String, default: '' },
  status: { 
    type: String, 
    enum: ['PLANNED', 'REGISTERED', 'SETUP_IN_PROGRESS', 'COMMISSIONED', 'ONLINE', 'OFFLINE', 'MAINTENANCE', 'DECOMMISSIONED'], 
    default: 'REGISTERED' 
  },
  commissionedAt: Date,
  commissionedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

projectGatewaySchema.index({ projectId: 1, gatewayId: 1 }, { unique: true });
projectGatewaySchema.index({ organizationId: 1, gatewayEui: 1 }, { sparse: true });
projectGatewaySchema.index({ organizationId: 1, imei: 1 }, { sparse: true });
projectGatewaySchema.index({ organizationId: 1, macAddress: 1 }, { sparse: true });

/**
 * SensorDeviceMapping Model
 * Represents the mapping connection between an actual Sensor (Instrument) and an actual Device.
 */
const sensorDeviceMappingSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  sensorAssetId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
  deviceAssetId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  connection: {
    mode: { type: String, enum: ['slot', 'bus'], default: 'slot' },
    slot: { type: Number },
    port: { type: String },
    address: { type: Number }
  },
  status: { type: String, enum: ['ACTIVE', 'UNASSIGNED', 'INACTIVE'], default: 'ACTIVE', index: true },
  mappedAt: { type: Date, default: Date.now },
  unmappedAt: { type: Date },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

sensorDeviceMappingSchema.index({ projectId: 1, sensorAssetId: 1, status: 1 });
sensorDeviceMappingSchema.index({ projectId: 1, deviceAssetId: 1, status: 1 });
sensorDeviceMappingSchema.index({ projectId: 1, deviceAssetId: 1, 'connection.slot': 1, status: 1 });

/**
 * DeviceGatewayMapping Model
 * Represents the mapping connection between an actual Device and an actual Gateway.
 */
const deviceGatewayMappingSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  deviceAssetId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  gatewayAssetId: { type: Schema.Types.ObjectId, ref: 'ProjectGateway', required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'UNASSIGNED', 'INACTIVE'], default: 'ACTIVE', index: true },
  mappedAt: { type: Date, default: Date.now },
  unmappedAt: { type: Date },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

deviceGatewayMappingSchema.index({ projectId: 1, deviceAssetId: 1, status: 1 });
deviceGatewayMappingSchema.index({ projectId: 1, gatewayAssetId: 1, status: 1 });

export const ProjectGateway = model('ProjectGateway', projectGatewaySchema);
export const SensorDeviceMapping = model('SensorDeviceMapping', sensorDeviceMappingSchema);
export const DeviceGatewayMapping = model('DeviceGatewayMapping', deviceGatewayMappingSchema);
