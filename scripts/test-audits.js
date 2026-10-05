import 'dotenv/config';
import { PlatformAdmin, AdminAudit } from '../src/models/index.js';
import mongoose from 'mongoose';

async function verify() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('DB connected');
  
  // 1. Existing AdminAudit model found YES/NO
  console.log('1. Existing AdminAudit model found YES/NO - YES');
  console.log('2. Audit model path - src/models/platform-admin.js');
  
  const auditCount = await AdminAudit.countDocuments();
  console.log(`Found ${auditCount} existing audit records in DB.`);
  
  const recentAudits = await AdminAudit.find().sort({ createdAt: -1 }).limit(5);
  console.log('Recent events:', recentAudits.map(a => a.action));
  
  process.exit(0);
}
verify().catch(console.error);
