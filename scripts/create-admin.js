import bcrypt from 'bcryptjs';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { PlatformAdmin, User, Organization, OrganizationMember } from '../src/models/index.js';

async function createAdmin() {
  await connectDb();
  
  const email = 'admin@geonexa.com';
  const password = 'Admin@Password123';
  const passwordHash = await bcrypt.hash(password, 12);
  
  // 1. Platform Admin
  const existingAdmin = await PlatformAdmin.findOne({ email });
  if (existingAdmin) {
    existingAdmin.passwordHash = passwordHash;
    existingAdmin.status = 'ACTIVE';
    await existingAdmin.save();
    console.log('Platform Admin updated.');
  } else {
    await PlatformAdmin.create({
      email,
      name: 'Super Admin',
      passwordHash,
      status: 'ACTIVE'
    });
    console.log('Platform Admin created successfully!');
  }

  // 2. Organization User (for /login)
  let user = await User.findOne({ email });
  if (user) {
    user.passwordHash = passwordHash;
    user.status = 'ACTIVE';
    await user.save();
    console.log('App User updated.');
  } else {
    user = await User.create({
      email,
      displayName: 'Platform Admin',
      passwordHash,
      status: 'ACTIVE'
    });
    const org = await Organization.findOne();
    if (org) {
      await OrganizationMember.create({
        organizationId: org._id,
        userId: user._id,
        organizationRole: 'ADMINISTRATOR',
        status: 'ACTIVE'
      });
    }
    console.log('App User created successfully!');
  }
  
  await disconnectDb();
}

createAdmin().catch(console.error);
