import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { env } from './src/config/env.js';

(async () => {
  await mongoose.connect(env.mongodbUri);
  const admin = await mongoose.model('PlatformAdmin').findOne({});
  const pToken = jwt.sign(
    { sub: admin._id.toString(), accountType: 'PLATFORM_ADMIN' },
    env.jwtSecret,
    { expiresIn: '1h' }
  );
  
  const org = await mongoose.model('Organization').findOne({});
  
  const user = await mongoose.model('User').findOne({});
  const uToken = jwt.sign(
    { sub: user._id.toString(), organizationId: org._id.toString(), organizationRole: 'ADMINISTRATOR' },
    env.jwtSecret,
    { expiresIn: '1h' }
  );

  console.log("TESTING WITH PLATFORM ADMIN TOKEN...");
  const res1 = await fetch(`http://localhost:3000/api/v1/admin/organizations/${org._id.toString()}`, {
    headers: { Authorization: `Bearer ${pToken}` }
  });
  console.log("P-ADMIN GET STATUS:", res1.status, await res1.text());

  console.log("TESTING WITH NORMAL USER TOKEN...");
  const res2 = await fetch(`http://localhost:3000/api/v1/admin/organizations/${org._id.toString()}`, {
    headers: { Authorization: `Bearer ${uToken}` }
  });
  console.log("USER GET STATUS:", res2.status, await res2.text());

  process.exit(0);
})();
