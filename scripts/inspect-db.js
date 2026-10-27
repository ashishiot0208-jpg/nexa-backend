import { env } from '../src/config/env.js';
import mongoose from 'mongoose';
import * as m from '../src/models/index.js';

async function check() {
  await mongoose.connect(env.mongoUri);
  const instruments = await m.Instrument.find({}).lean();
  console.log('EXISTING INSTRUMENTS:', instruments.map(i => ({ id: i._id, name: i.name, code: i.code, catalogCode: i.catalogCode, projectId: i.projectId, metadata: i.metadata })));
  const devices = await m.Device.find({}).lean();
  console.log('EXISTING DEVICES:', devices.map(d => ({ id: d._id, deviceId: d.deviceId, name: d.name, deviceType: d.deviceType, metadata: d.metadata })));
  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
