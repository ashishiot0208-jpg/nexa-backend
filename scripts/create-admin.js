import bcrypt from 'bcryptjs';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { PlatformAdmin } from '../src/models/index.js';

async function createAdmin() {
  await connectDb();
  
  const email = 'admin@geonexa.com';
  const password = 'Admin@Password123';
  
  const existingAdmin = await PlatformAdmin.findOne({ email });
  if (existingAdmin) {
    console.log('Admin already exists. Updating password...');
    existingAdmin.passwordHash = await bcrypt.hash(password, 12);
    await existingAdmin.save();
    console.log('Admin password updated.');
  } else {
    await PlatformAdmin.create({
      email,
      name: 'Super Admin',
      passwordHash: await bcrypt.hash(password, 12),
      status: 'ACTIVE'
    });
    console.log('Platform Admin created successfully!');
  }
  
  await disconnectDb();
}

createAdmin().catch(console.error);
