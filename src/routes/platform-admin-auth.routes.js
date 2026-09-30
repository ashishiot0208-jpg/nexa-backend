import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { PlatformAdmin } from '../models/index.js';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });

router.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const admin = await PlatformAdmin.findOne({ email: req.body.email.toLowerCase() });
  if (!admin || admin.status !== 'ACTIVE' || !(await bcrypt.compare(req.body.password, admin.passwordHash))) {
    throw new ApiError(401, 'Invalid email or password');
  }
  
  admin.lastLoginAt = new Date(); 
  await admin.save();
  
  const token = jwt.sign(
    { accountType: 'PLATFORM_ADMIN' }, 
    env.jwtSecret, 
    { subject: admin._id.toString(), expiresIn: env.jwtExpiresIn }
  );
  
  res.json({ 
    token, 
    admin: { id: admin._id, email: admin.email, name: admin.name } 
  });
}));

router.get('/me', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  res.json(req.adminAuth);
}));

router.post('/logout', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  res.json({ message: 'Logged out successfully' });
}));

export default router;
