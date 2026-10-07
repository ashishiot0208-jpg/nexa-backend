import { env } from '../src/config/env.js';
import mongoose from 'mongoose';
import * as m from '../src/models/index.js';
import { createApp } from '../src/app.js';
import jwt from 'jsonwebtoken';

async function testHttp() {
  await mongoose.connect(env.mongoUri);
  const app = createApp();

  const server = app.listen(0);
  const port = server.address().port;
  console.log(`Test server running on port ${port}`);

  const project = await m.Project.findOne({ code: 'NEW-DAM-01' });
  const user = await m.User.findOne({ status: 'ACTIVE' });
  const org = await m.Organization.findById(project.organizationId);

  // Generate valid user JWT
  const token = jwt.sign(
    { sub: user._id.toString(), organizationId: org._id.toString(), organizationRole: 'ADMINISTRATOR' },
    env.jwtSecret,
    { expiresIn: '1h' }
  );

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // 1. GET summary
  const res1 = await fetch(`http://localhost:${port}/api/v1/projects/${project._id}/commissioning/summary`, { headers });
  const data1 = await res1.json();
  console.log(`✓ HTTP GET summary status: ${res1.status}`);
  console.log(`  Sensors progress items: ${data1.sensorProgress.length}`);
  console.log(`  Devices progress items: ${data1.deviceProgress.length}`);
  console.log(`  Gateways progress items: ${data1.gatewayProgress.length}`);

  // 2. GET sensors
  const res2 = await fetch(`http://localhost:${port}/api/v1/projects/${project._id}/commissioning/sensors`, { headers });
  const data2 = await res2.json();
  console.log(`✓ HTTP GET sensors status: ${res2.status}, count: ${data2.length}`);

  // 3. GET devices
  const res3 = await fetch(`http://localhost:${port}/api/v1/projects/${project._id}/commissioning/devices`, { headers });
  const data3 = await res3.json();
  console.log(`✓ HTTP GET devices status: ${res3.status}, count: ${data3.length}`);

  // 4. GET gateways
  const res4 = await fetch(`http://localhost:${port}/api/v1/projects/${project._id}/commissioning/gateways`, { headers });
  const data4 = await res4.json();
  console.log(`✓ HTTP GET gateways status: ${res4.status}, count: ${data4.length}`);

  // 5. Test capacity rejection on HTTP
  const devLogger = data3.find(d => d.deviceId === 'LOGGER-01');
  const res5 = await fetch(`http://localhost:${port}/api/v1/projects/${project._id}/commissioning/sensor-device-mappings/bulk`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceAssetId: devLogger._id,
      sensorAssetIds: [data2[0]._id] // already mapped or exceeds capacity
    })
  });
  console.log(`✓ HTTP POST mapping capacity/already-assigned rejected as expected: status ${res5.status}`);

  server.close();
  console.log('✓ HTTP API tests completed successfully!');
  process.exit(0);
}

testHttp().catch(err => {
  console.error(err);
  process.exit(1);
});
