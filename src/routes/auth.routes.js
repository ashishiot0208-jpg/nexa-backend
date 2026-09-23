import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { OrganizationMember, User } from '../models/index.js';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });

router.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() });
  if (!user || user.status !== 'ACTIVE' || !(await bcrypt.compare(req.body.password, user.passwordHash))) throw new ApiError(401, 'Invalid email or password');
  const member = await OrganizationMember.findOne({ userId: user._id, status: 'ACTIVE' }).lean();
  if (!member) throw new ApiError(403, 'No active organisation membership');
  user.lastActiveAt = new Date(); await user.save();
  const token = jwt.sign({ organizationId: member.organizationId.toString(), organizationRole: member.organizationRole }, env.jwtSecret, { subject: user._id.toString(), expiresIn: env.jwtExpiresIn });
  res.json({ token, user: { id: user._id, email: user.email, displayName: user.displayName, organizationId: member.organizationId, organizationRole: member.organizationRole } });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => res.json(req.auth)));
export default router;
