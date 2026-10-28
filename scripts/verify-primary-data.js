import mongoose from 'mongoose';

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/geonexa');
  const db = mongoose.connection.db;

  const project = await db.collection('projects').findOne({ code: 'LAN-PRO-01' });
  if (!project) {
    console.log('Project LAN-PRO-01 not found');
    await mongoose.disconnect();
    return;
  }

  const pId = project._id;
  console.log('=== PROJECT LAN-PRO-01 ===');
  console.log('ID:', pId.toString());
  console.log('Code:', project.code);
  console.log('Name:', project.name);

  // SECTION 1: Counts for project
  // Check both ObjectId and string
  async function countBoth(collName, queryBuilder) {
    const qObj = queryBuilder(pId);
    const qStr = queryBuilder(pId.toString());
    const cObj = await db.collection(collName).countDocuments(qObj);
    const cStr = await db.collection(collName).countDocuments(qStr);
    return { obj: cObj, str: cStr, total: cObj + cStr };
  }

  const instCounts = await countBoth('instruments', (p) => ({ projectId: p }));
  const derivedCounts = await countBoth('derivedreadings', (p) => ({ projectId: p }));
  const rawCounts = await countBoth('rawreadings', (p) => ({ projectId: p }));
  const latestCounts = await countBoth('lateststates', (p) => ({ projectId: p }));
  const alarmsL2Counts = await countBoth('alarms', (p) => ({ projectId: p, lifecycleVersion: 2 }));
  const alarmsAllCounts = await countBoth('alarms', (p) => ({ projectId: p }));
  const singleAlarm = await db.collection('alarms').findOne({ projectId: pId });
  console.log('Single alarm found:', JSON.stringify(singleAlarm, null, 2));
  const invL1Counts = await countBoth('investigations', (p) => ({ projectId: p, lifecycleVersion: 1 }));
  const invAllCounts = await countBoth('investigations', (p) => ({ projectId: p }));
  const devicesCounts = await countBoth('devices', (p) => ({ projectId: p }));
  const gatewaysCounts = await countBoth('projectgateways', (p) => ({ projectId: p }));
  const rulesCounts = await countBoth('engineeringseverityrules', (p) => ({ projectId: p }));

  console.log('\n=== SECTION 1: ACTUAL COUNTS ===');
  console.log('Instruments:', instCounts);
  console.log('DerivedReading:', derivedCounts);
  console.log('RawReading:', rawCounts);
  console.log('LatestState:', latestCounts);
  console.log('Alarms (lifecycleVersion: 2):', alarmsL2Counts, 'All Alarms:', alarmsAllCounts);
  console.log('Investigations (lifecycleVersion: 1):', invL1Counts, 'All Investigations:', invAllCounts);
  console.log('Devices:', devicesCounts);
  console.log('Gateways (projectgateways):', gatewaysCounts);
  console.log('EngineeringSeverityRule:', rulesCounts);

  // INC-2026-0001
  const inst = await db.collection('instruments').findOne({ code: 'INC-2026-0001' });
  console.log('\n=== INC-2026-0001 DETAILS ===');
  if (inst) {
    console.log('MongoDB _id:', inst._id.toString());
    console.log('instrument code:', inst.code);
    console.log('instrument name:', inst.name);
    console.log('projectId on instrument:', inst.projectId, 'type:', typeof inst.projectId, inst.projectId.constructor.name);

    const channels = await db.collection('sensorchannels').find({ instrumentId: inst._id }).toArray();
    const channelsByStr = await db.collection('sensorchannels').find({ instrumentId: inst._id.toString() }).toArray();
    console.log('Channels count (ObjectId):', channels.length, '(String):', channelsByStr.length);
    const allChannels = channels.length ? channels : channelsByStr;
    console.log('Channels:');
    allChannels.forEach(c => {
      console.log(`  - _id: ${c._id}, code: ${c.code}, label: ${c.label}, parameterCode: ${c.parameterCode}, unit: ${c.engineeringUnit || c.rawUnit}`);
    });

    const derivedObj = await db.collection('derivedreadings').countDocuments({ instrumentId: inst._id });
    const derivedStr = await db.collection('derivedreadings').countDocuments({ instrumentId: inst._id.toString() });
    console.log('DerivedReading count for instrument (ObjectId):', derivedObj, '(String):', derivedStr);

    const targetQuery = derivedObj > 0 ? { instrumentId: inst._id } : { instrumentId: inst._id.toString() };
    
    // Find sample document
    const sample = await db.collection('derivedreadings').findOne(targetQuery);
    console.log('\nSample DerivedReading:');
    console.log(JSON.stringify(sample, null, 2));

    // Also check timestamps: observedAt vs timestamp vs createdAt
    const oldest = await db.collection('derivedreadings').find(targetQuery).sort({ observedAt: 1 }).limit(1).toArray();
    const newest = await db.collection('derivedreadings').find(targetQuery).sort({ observedAt: -1 }).limit(1).toArray();
    console.log('Oldest observedAt:', oldest[0]?.observedAt || oldest[0]?.timestamp || oldest[0]?.createdAt);
    console.log('Newest observedAt:', newest[0]?.observedAt || newest[0]?.timestamp || newest[0]?.createdAt);

    // Distinct parameterCode in derivedreadings for this instrument
    const distinctParams = await db.collection('derivedreadings').distinct('parameterCode', targetQuery);
    console.log('Distinct parameterCode in DerivedReading:', distinctParams);
    const distinctChannelCodes = await db.collection('derivedreadings').distinct('channelCode', targetQuery);
    console.log('Distinct channelCode in DerivedReading:', distinctChannelCodes);
  } else {
    console.log('INC-2026-0001 NOT FOUND!');
    const anyInst = await db.collection('instruments').find({ projectId: pId }).limit(5).toArray();
    console.log('Some instruments in project:', anyInst.map(i => ({ _id: i._id, code: i.code, name: i.name })));
  }

  await mongoose.disconnect();
}

main().catch(console.error);
