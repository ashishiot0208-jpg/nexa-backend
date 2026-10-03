import { Router } from 'express';
import { z } from 'zod';
import { GatewayType, AdminAudit } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const typeSchema = z.object({
  name: z.string().min(1)
});

const generateCode = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
};

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const types = await GatewayType.find().sort({ createdAt: -1 }).lean();
  res.json(types);
}));

router.post('/', requirePlatformAdminAuth, validate(typeSchema), asyncHandler(async (req, res) => {
  const code = generateCode(req.body.name);
  
  const existing = await GatewayType.findOne({ code });
  if (existing) {
    throw new ApiError(400, 'A Gateway Type with a similar name already exists.');
  }

  const type = await GatewayType.create({
    name: req.body.name,
    code,
    status: 'active'
  });

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'GATEWAY_TYPE_CREATED',
    targetType: 'GatewayType',
    targetId: type._id
  });

  res.status(201).json(type);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(typeSchema), asyncHandler(async (req, res) => {
  const type = await GatewayType.findById(req.params.id);
  if (!type) throw new ApiError(404, 'Gateway Type not found');

  type.name = req.body.name;
  await type.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'GATEWAY_TYPE_UPDATED',
    targetType: 'GatewayType',
    targetId: type._id
  });

  res.json(type);
}));

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const type = await GatewayType.findById(req.params.id);
  if (!type) throw new ApiError(404, 'Gateway Type not found');

  type.status = req.body.status;
  await type.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'active' ? 'GATEWAY_TYPE_ACTIVATED' : 'GATEWAY_TYPE_DEACTIVATED',
    targetType: 'GatewayType',
    targetId: type._id
  });

  res.json(type);
}));

export default router;
