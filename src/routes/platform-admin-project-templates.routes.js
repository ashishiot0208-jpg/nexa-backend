import { Router } from 'express';
import { z } from 'zod';
import { ProjectTemplate, AdminAudit } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const sensorItemSchema = z.object({
  sensor_uid: z.string().min(1),
  default_quantity: z.number().int().min(1)
});

const deviceItemSchema = z.object({
  device_uid: z.string().min(1),
  default_quantity: z.number().int().min(1)
});

const gatewayItemSchema = z.object({
  gateway_uid: z.string().min(1),
  default_quantity: z.number().int().min(1)
});

const templateSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().optional(),
  sensors: z.array(sensorItemSchema).default([]),
  devices: z.array(deviceItemSchema).default([]),
  gateways: z.array(gatewayItemSchema).default([])
});

const checkDuplicates = (items, key) => {
  const uids = items.map(item => item[key]);
  const unique = new Set(uids);
  if (unique.size !== uids.length) {
    throw new ApiError(400, `Duplicate ${key} found in template.`);
  }
};

const checkAtLeastOneItem = (body) => {
  const count = (body.sensors?.length || 0) + (body.devices?.length || 0) + (body.gateways?.length || 0);
  if (count === 0) {
    throw new ApiError(400, 'Template must contain at least one catalogue item (Sensor, Device, or Gateway).');
  }
};

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const templates = await ProjectTemplate.find().sort({ createdAt: -1 }).lean();
  res.json(templates);
}));

router.get('/:id', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const template = await ProjectTemplate.findById(req.params.id).lean();
  if (!template) throw new ApiError(404, 'Project Template not found');
  res.json(template);
}));

router.post('/', requirePlatformAdminAuth, validate(templateSchema), asyncHandler(async (req, res) => {
  checkAtLeastOneItem(req.body);
  checkDuplicates(req.body.sensors, 'sensor_uid');
  checkDuplicates(req.body.devices, 'device_uid');
  checkDuplicates(req.body.gateways, 'gateway_uid');
  
  const template = await ProjectTemplate.create({
    name: req.body.name,
    type: req.body.type,
    description: req.body.description || '',
    sensors: req.body.sensors,
    devices: req.body.devices,
    gateways: req.body.gateways,
    status: 'active'
  });

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'PROJECT_TEMPLATE_CREATED',
    targetType: 'ProjectTemplate',
    targetId: template._id
  });

  res.status(201).json(template);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(templateSchema), asyncHandler(async (req, res) => {
  checkAtLeastOneItem(req.body);
  checkDuplicates(req.body.sensors, 'sensor_uid');
  checkDuplicates(req.body.devices, 'device_uid');
  checkDuplicates(req.body.gateways, 'gateway_uid');
  
  const template = await ProjectTemplate.findById(req.params.id);
  if (!template) throw new ApiError(404, 'Project Template not found');

  template.name = req.body.name;
  template.type = req.body.type;
  template.description = req.body.description || '';
  template.sensors = req.body.sensors;
  template.devices = req.body.devices;
  template.gateways = req.body.gateways;
  
  await template.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'PROJECT_TEMPLATE_UPDATED',
    targetType: 'ProjectTemplate',
    targetId: template._id
  });

  res.json(template);
}));

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const template = await ProjectTemplate.findById(req.params.id);
  if (!template) throw new ApiError(404, 'Project Template not found');

  template.status = req.body.status;
  await template.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'active' ? 'PROJECT_TEMPLATE_ACTIVATED' : 'PROJECT_TEMPLATE_DEACTIVATED',
    targetType: 'ProjectTemplate',
    targetId: template._id
  });

  res.json(template);
}));

export default router;
