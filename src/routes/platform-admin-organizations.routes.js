import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Organization, User, OrganizationMember } from '../models/index.js';
import { AdminAudit } from '../models/platform-admin.js';
import { validate } from '../middleware/validate.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();

const createOrgSchema = z.object({
  name: z.string().min(2),
  address: z.string().min(5),
  contactPerson: z.string().min(2),
  mobile: z.string().min(5),
  email: z.string().email()
});

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const orgs = await Organization.find().sort({ createdAt: -1 }).lean();
  res.json(orgs);
}));

router.post('/', requirePlatformAdminAuth, validate(createOrgSchema), asyncHandler(async (req, res) => {
  const { name, address, contactPerson, mobile, email } = req.body;
  const lowerEmail = email.toLowerCase();
  
  const existingUser = await User.findOne({ email: lowerEmail });
  if (existingUser) {
    throw new ApiError(409, 'User with this email already exists');
  }

  const generatedCode = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 8) + Math.random().toString(36).substring(2, 6).toUpperCase();

  const setupToken = crypto.randomBytes(32).toString('hex');
  const tempPassword = crypto.randomBytes(12).toString('hex');
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  
  let organization;
  try {
    organization = await Organization.create({
      name,
      code: generatedCode,
      address,
      contactPerson,
      mobile,
      email: lowerEmail,
      status: 'ACTIVE'
    });

    const user = await User.create({
      email: lowerEmail,
      displayName: contactPerson,
      passwordHash,
      status: 'INVITED',
      setupToken,
      setupTokenExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await OrganizationMember.create({
      organizationId: organization._id,
      userId: user._id,
      organizationRole: 'ADMINISTRATOR',
      status: 'ACTIVE'
    });
    
    await AdminAudit.create({
      adminId: req.adminAuth.adminId,
      action: 'ORGANIZATION_CREATED',
      targetType: 'Organization',
      targetId: organization._id
    });
    
    res.status(201).json({
      organization,
      setupToken, // Provide token for one-time setup
      tempPassword // In a real app we'd email this, but requirement says return it to Admin
    });
  } catch (error) {
    if (organization && organization._id) {
      await Organization.deleteOne({ _id: organization._id });
      await User.deleteOne({ email: lowerEmail });
      await OrganizationMember.deleteMany({ organizationId: organization._id });
    }
    throw error;
  }
}));

router.get('/:id', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id).lean();
  if (!org) throw new ApiError(404, 'Organization not found');
  res.json(org);
}));

router.patch('/:id', requirePlatformAdminAuth, validate(createOrgSchema), asyncHandler(async (req, res) => {
  const { name, address, contactPerson, mobile, email } = req.body;
  const org = await Organization.findById(req.params.id);
  if (!org) throw new ApiError(404, 'Organization not found');

  const lowerEmail = email.toLowerCase();
  
  if (org.email !== lowerEmail) {
    const existingUser = await User.findOne({ email: lowerEmail });
    if (existingUser) {
      throw new ApiError(409, 'User with this email already exists');
    }
    
    const initialUser = await User.findOne({ email: org.email });
    if (initialUser) {
      initialUser.email = lowerEmail;
      await initialUser.save();
    }
  }
  
  org.name = name;
  org.address = address;
  org.contactPerson = contactPerson;
  org.mobile = mobile;
  org.email = lowerEmail;
  await org.save();
  
  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'ORGANIZATION_UPDATED',
    targetType: 'Organization',
    targetId: org._id
  });
  
  res.json(org);
}));

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) });

router.patch('/:id/status', requirePlatformAdminAuth, validate(statusSchema), asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id);
  if (!org) throw new ApiError(404, 'Organization not found');

  org.status = req.body.status;
  await org.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: req.body.status === 'ACTIVE' ? 'ORGANIZATION_ACTIVATED' : 'ORGANIZATION_DEACTIVATED',
    targetType: 'Organization',
    targetId: org._id
  });
  
  res.json(org);
}));

router.post('/:id/resend-invite', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id);
  if (!org) throw new ApiError(404, 'Organization not found');

  const user = await User.findOne({ email: org.email });
  if (!user) throw new ApiError(404, 'Primary user not found for this organization');

  if (user.status === 'ACTIVE') {
    throw new ApiError(400, 'User is already active. Cannot resend invite.');
  }

  const setupToken = crypto.randomBytes(32).toString('hex');
  user.setupToken = setupToken;
  user.setupTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await user.save();

  await AdminAudit.create({
    adminId: req.adminAuth.adminId,
    action: 'ORGANIZATION_INVITE_RESENT',
    targetType: 'Organization',
    targetId: org._id
  });

  res.json({ setupToken, message: 'Invite generated successfully' });
}));

export default router;
