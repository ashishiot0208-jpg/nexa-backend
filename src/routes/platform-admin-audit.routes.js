import { Router } from 'express';
import { AdminAudit } from '../models/index.js';
import { requirePlatformAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';

const router = Router();

router.get('/', requirePlatformAdminAuth, asyncHandler(async (req, res) => {
  const { action, targetType, from, to, search, page = 1, limit = 20 } = req.query;
  const query = {};

  if (action && action !== 'ALL') query.action = action;
  if (targetType && targetType !== 'ALL') query.targetType = targetType;
  
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = new Date(from);
    if (to) query.createdAt.$lte = new Date(to);
  }

  // Populate admin to get the admin name/email, and we would normally need target name.
  // The schema currently does not have targetName. It only has targetId and targetType.
  // We can just populate adminId.
  let audits = await AdminAudit.find(query)
    .sort({ createdAt: -1 })
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .populate('adminId', 'name email')
    .lean();

  // If search is provided, we can filter in memory or via regex.
  // For simplicity, filter in memory for name/email if a simple search is needed.
  if (search) {
    const s = search.toLowerCase();
    audits = audits.filter(a => {
      const adminName = a.adminId?.name?.toLowerCase() || '';
      const adminEmail = a.adminId?.email?.toLowerCase() || '';
      const actionMatch = a.action.toLowerCase().includes(s);
      return adminName.includes(s) || adminEmail.includes(s) || actionMatch;
    });
  }

  const total = await AdminAudit.countDocuments(query);

  res.json({
    data: audits,
    meta: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit))
    }
  });
}));

export default router;
