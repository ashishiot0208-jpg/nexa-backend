#!/usr/bin/env node
/**
 * Standalone Idempotent Index Migration Script
 *
 * Usage:
 *   node scripts/migrate-rawreading-index.js
 *   npm run migrate:indexes
 */

import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { ensureIndexesMigrated } from '../src/config/index-migration.js';

const mongoUri = process.env.MONGODB_URI || env.mongoUri || 'mongodb://127.0.0.1:27017/geonexa';

async function run() {
  console.log('========================================================');
  console.log('NexaIQ Deployment Index Migration');
  console.log(`Connecting to: ${mongoUri}`);
  console.log('========================================================\n');

  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    const result = await ensureIndexesMigrated(mongoose.connection.db);

    console.log('\nMigration Summary:');
    console.log(`- Obsolete rawreadings index dropped: ${result.rawResult.droppedOld}`);
    console.log(`- Target multi-slot rawreadings index created: ${result.rawResult.createdNew}`);
    console.log(`- SensorChannel index collation upgraded: ${result.scResult.upgraded}`);
    console.log('\n[SUCCESS] Index migration finished cleanly.');
    process.exit(0);
  } catch (err) {
    console.error('\n[FATAL] Index migration failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

run();

