import { MongoMemoryServer } from 'mongodb-memory-server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../.mongo-data');

if (!fs.existsSync(dbPath)) {
  fs.mkdirSync(dbPath, { recursive: true });
}

console.log('Starting local MongoDB server on 127.0.0.1:27017...');

try {
  const mongod = await MongoMemoryServer.create({
    binary: {
      version: '6.0.19'
    },
    instance: {
      port: 27017,
      ip: '127.0.0.1',
      dbName: 'geonexa',
      dbPath,
      storageEngine: 'wiredTiger'
    }
  });

  const uri = mongod.getUri();
  console.log('\n======================================================');
  console.log(' Local MongoDB Server is RUNNING');
  console.log(` Connection URI: ${uri}geonexa`);
  console.log(` Data Directory: ${dbPath}`);
  console.log('======================================================');
  console.log('Ready for "npm run dev", "npm run seed", and MongoDB Compass!\n');

  const shutdown = async () => {
    console.log('\nStopping local MongoDB server...');
    await mongod.stop();
    console.log('MongoDB server stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  if (err.message && err.message.includes('EADDRINUSE')) {
    console.error('\nError: Port 27017 is already in use.');
  } else {
    console.error('Failed to start local MongoDB:', err);
  }
  process.exit(1);
}
