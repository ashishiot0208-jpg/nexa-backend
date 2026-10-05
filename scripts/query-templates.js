import mongoose from 'mongoose';
import 'dotenv/config';
import { ProjectTemplate } from '../src/models/index.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');
  const templates = await ProjectTemplate.find().lean();
  console.log('Templates in DB:', templates);
  process.exit(0);
}

run().catch(console.error);
