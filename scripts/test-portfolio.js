import mongoose from 'mongoose';
import assert from 'assert';
import dotenv from 'dotenv';
import { getPortfolioSummary } from '../src/services/portfolio.service.js';
import { Project, RawReading, Instrument, SensorChannel } from '../src/models/index.js';

dotenv.config();
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geonexa';

async function runTests() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB for Portfolio tests');

  try {
    const projects = await Project.find().lean();
    assert(projects.length > 0, 'Should have projects in the DB');
    const projectIds = projects.map(p => p._id);

    const summaries = await getPortfolioSummary(projectIds);
    assert(summaries.size === projects.length, 'Should return summary for each project');

    const nh10 = projects.find(p => p.code === 'NH-10');
    const nh10Summary = summaries.get(nh10._id.toString());
    
    assert(nh10Summary, 'NH-10 summary should exist');
    assert(nh10Summary.operationalStatus.severity, 'Should have severity');
    assert(nh10Summary.counts.cameras >= 1, 'Should have at least 1 camera for NH-10');
    assert(nh10Summary.counts.gateways >= 1, 'Should have at least 1 gateway');

    // Test duplicate reading protection
    // Let's create a duplicate RawReading manually
    const channel = await SensorChannel.findOne({ projectId: nh10._id, enabled: true }).lean();
    if (channel) {
      const now = new Date();
      // Insert two readings at the exact same sampleTime (duplicate logical sample)
      const id1 = 'dup_' + Date.now() + '_1';
      const id2 = 'dup_' + Date.now() + '_2';
      await RawReading.insertMany([
        { ingestionId: id1, messageId: 'msg1', channelCode: 'c1', projectId: nh10._id, channelId: channel._id, sampleTime: now, organizationId: nh10.organizationId, deviceId: nh10._id, originalPacket: {} },
        { ingestionId: id2, messageId: 'msg2', channelCode: 'c2', projectId: nh10._id, channelId: channel._id, sampleTime: now, organizationId: nh10.organizationId, deviceId: nh10._id, originalPacket: {} },
      ]);

      const summariesAfterDup = await getPortfolioSummary([nh10._id]);
      const afterDup = summariesAfterDup.get(nh10._id.toString());
      
      // Cleanup
      await RawReading.deleteMany({ ingestionId: { $in: [id1, id2] } });
      
      const beforeDupCount = nh10Summary.availability.received;
      const afterDupCount = afterDup.availability.received;
      
      assert.strictEqual(afterDupCount, beforeDupCount + 1, 'Duplicate logical samples (same channel & time) must be counted exactly once.');

      console.log('Duplicate reading protection verified.');
    }

    console.log('All backend portfolio tests passed successfully.');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

runTests();
