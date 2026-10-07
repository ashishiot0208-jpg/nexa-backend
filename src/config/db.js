import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let embeddedMongod = null;

export async function connectDb() {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(env.mongoUri, {
      autoIndex: env.nodeEnv !== 'production',
      serverSelectionTimeoutMS: 3000
    });
    return mongoose.connection;
  } catch (err) {
    const isConnRefused = err.message && (err.message.includes('ECONNREFUSED') || err.name === 'MongooseServerSelectionError');
    const isLocalhost = env.mongoUri.includes('127.0.0.1:27017') || env.mongoUri.includes('localhost:27017');

    if (isConnRefused && isLocalhost) {
      console.log('\n⚠️  MongoDB is not running on 127.0.0.1:27017.');
      console.log('🔄 Auto-starting local MongoDB server (.mongo-data)...');
      try {
        const { MongoMemoryServer } = await import('mongodb-memory-server');
        const dbPath = path.resolve(__dirname, '../../.mongo-data');
        if (!fs.existsSync(dbPath)) {
          fs.mkdirSync(dbPath, { recursive: true });
        }

        embeddedMongod = await MongoMemoryServer.create({
          binary: { version: '6.0.19' },
          instance: {
            port: 27017,
            ip: '127.0.0.1',
            dbName: 'geonexa',
            dbPath,
            storageEngine: 'wiredTiger'
          }
        });

        console.log('✅ Local MongoDB server started automatically on 127.0.0.1:27017');
        
        await mongoose.connect(env.mongoUri, {
          autoIndex: env.nodeEnv !== 'production',
          serverSelectionTimeoutMS: 5000
        });

        const shutdown = async () => {
          if (embeddedMongod) {
            await embeddedMongod.stop();
          }
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        return mongoose.connection;
      } catch (autoErr) {
        console.error('Failed to auto-start local MongoDB:', autoErr.message);
      }
    }

    if (isConnRefused) {
      console.error('\n======================================================');
      console.error('❌ MONGODB CONNECTION ERROR: Connection refused');
      console.error(`   Target URI: ${env.mongoUri}`);
      console.error('------------------------------------------------------');
      console.error('👉 To start the local MongoDB server, run this in a terminal:');
      console.error('   npm run mongo:local');
      console.error('======================================================\n');
    }
    throw err;
  }
}

export async function disconnectDb() {
  await mongoose.disconnect();
  if (embeddedMongod) {
    await embeddedMongod.stop();
  }
}
