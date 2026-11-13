import assert from 'node:assert/strict';

console.log('=== STARTING DEVICE & GATEWAY CORRELATION E2E TEST ===\n');

// 1. Authenticate
const authRes = await fetch('http://localhost:3000/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@geonexa.com', password: 'Admin@Password123' })
});
assert.equal(authRes.status, 200, 'Authentication must succeed with HTTP 200');
const { token } = await authRes.json();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// 2. Test Device API with human-readable project code LAN-PRO-01
console.log('Step 1: Testing Device API with project code LAN-PRO-01...');
const devUrlCode = 'http://localhost:3000/api/v1/projects/LAN-PRO-01/correlation-devices';
const devResCode = await fetch(devUrlCode, { headers });
console.log('  Request URL:', devUrlCode);
console.log('  Project Identifier:', 'LAN-PRO-01');
console.log('  HTTP Status:', devResCode.status);
assert.equal(devResCode.status, 200, 'Device API with project code must return 200');
const devBodyCode = await devResCode.json();
console.log('  Response count:', devBodyCode.length);
console.log('  Sample device item:', devBodyCode[0]);
assert.ok(Array.isArray(devBodyCode), 'Device response must be a JSON array');
assert.ok(devBodyCode.length > 0, 'Project must contain devices');
for (const d of devBodyCode) {
  assert.ok(d._id, 'Device must contain _id');
  assert.ok(d.deviceId, 'Device must contain deviceId');
  assert.ok(d.name, 'Device must contain name');
  assert.notEqual(d.status, 'DECOMMISSIONED', 'Decommissioned devices must be excluded');
}

// 3. Test Gateway API with human-readable project code LAN-PRO-01
console.log('\nStep 2: Testing Gateway API with project code LAN-PRO-01...');
const gwUrlCode = 'http://localhost:3000/api/v1/projects/LAN-PRO-01/correlation-gateways';
const gwResCode = await fetch(gwUrlCode, { headers });
console.log('  Request URL:', gwUrlCode);
console.log('  Project Identifier:', 'LAN-PRO-01');
console.log('  HTTP Status:', gwResCode.status);
assert.equal(gwResCode.status, 200, 'Gateway API with project code must return 200');
const gwBodyCode = await gwResCode.json();
console.log('  Response count:', gwBodyCode.length);
console.log('  Sample gateway item:', gwBodyCode[0]);
assert.ok(Array.isArray(gwBodyCode), 'Gateway response must be a JSON array');
assert.ok(gwBodyCode.length > 0, 'Project must contain at least 1 gateway');
for (const g of gwBodyCode) {
  assert.ok(g._id, 'Gateway must contain _id');
  assert.ok(g.gatewayId, 'Gateway must contain gatewayId');
  assert.ok(g.name, 'Gateway must contain name');
  assert.notEqual(g.status, 'DECOMMISSIONED', 'Decommissioned gateways must be excluded');
}

// 4. Test with canonical Mongo ObjectId
console.log('\nStep 3: Testing Device & Gateway API with Mongo ObjectId (6ac64b0f222202652768acaf)...');
const devResId = await fetch('http://localhost:3000/api/v1/projects/6ac64b0f222202652768acaf/correlation-devices', { headers });
assert.equal(devResId.status, 200);
const devBodyId = await devResId.json();
assert.equal(devBodyId.length, devBodyCode.length, 'Code and ObjectId must return identical device counts');

const gwResId = await fetch('http://localhost:3000/api/v1/projects/6ac64b0f222202652768acaf/correlation-gateways', { headers });
assert.equal(gwResId.status, 200);
const gwBodyId = await gwResId.json();
assert.equal(gwBodyId.length, gwBodyCode.length, 'Code and ObjectId must return identical gateway counts');
console.log('  ✓ Project code and Mongo ObjectId normalization verified.');

// 5. Test Save Flow and Reload with Device and Gateway nodes
console.log('\nStep 4: Testing Save Flow and Persistence with Device and Gateway nodes...');
const targetDevice = devBodyCode.find(d => d.deviceId === 'SNRS485-2026-0001') || devBodyCode[0];
const targetGateway = gwBodyCode.find(g => g.gatewayId === 'GWLR-2026-0001') || gwBodyCode[0];

const testGraph = {
  nodes: [
    {
      id: 'node_dev_test',
      type: 'Device',
      family: 'DATA',
      title: targetDevice.deviceId,
      position: { x: 50, y: 150 },
      config: {
        deviceId: String(targetDevice._id),
        deviceCode: targetDevice.deviceId,
        deviceName: targetDevice.name,
        metric: 'batteryV'
      }
    },
    {
      id: 'node_gw_test',
      type: 'Gateway',
      family: 'CONTEXT',
      title: targetGateway.gatewayId,
      position: { x: 50, y: 300 },
      config: {
        gatewayId: String(targetGateway._id),
        gatewayCode: targetGateway.gatewayId,
        name: targetGateway.name
      }
    },
    {
      id: 'node_corr_test',
      type: 'Correlation',
      family: 'RELATIONSHIP',
      title: 'Pearson Correlation',
      position: { x: 300, y: 150 },
      config: {
        method: 'PEARSON',
        lagSearch: false,
        maxLagHours: 24,
        lagStepHours: 1,
        minSamples: 5,
        qualityFilter: ['VALID']
      }
    },
    {
      id: 'node_res_test',
      type: 'Result',
      family: 'OUTPUT',
      title: 'Evidence Result',
      position: { x: 550, y: 200 },
      config: {}
    }
  ],
  edges: [
    { id: 'edge_dev_corr', sourceNodeId: 'node_dev_test', sourcePort: 'series', targetNodeId: 'node_corr_test', targetPort: 'seriesA' },
    { id: 'edge_corr_res', sourceNodeId: 'node_corr_test', sourcePort: 'correlationResult', targetNodeId: 'node_res_test', targetPort: 'correlationIn' },
    { id: 'edge_gw_res', sourceNodeId: 'node_gw_test', sourcePort: 'gatewayContext', targetNodeId: 'node_res_test', targetPort: 'gatewayIn' }
  ]
};

const createModelRes = await fetch('http://localhost:3000/api/v1/projects/LAN-PRO-01/correlation-models', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: 'LAN-PRO-01 Device & Gateway E2E Flow',
    graphJson: testGraph
  })
});
assert.equal(createModelRes.status, 201, 'Model creation must succeed with HTTP 201');
const createdModel = await createModelRes.json();
console.log('  Created Model ID:', createdModel._id);
console.log('  Validation valid:', createdModel.versions[0]?.validationResult?.valid);
assert.equal(createdModel.versions[0]?.validationResult?.valid, true, 'Saved graph must pass graph validation');

// 6. Reload Model and verify exact identity restoration
console.log('\nStep 5: Reloading saved flow and verifying identity restoration...');
const reloadRes = await fetch(`http://localhost:3000/api/v1/projects/LAN-PRO-01/correlation-models/${createdModel._id}`, { headers });
assert.equal(reloadRes.status, 200, 'Model reload must return HTTP 200');
const reloaded = await reloadRes.json();

const reloadedDevNode = reloaded.versions[0]?.graphJson?.nodes?.find(n => n.type === 'Device');
assert.ok(reloadedDevNode, 'Device node must exist in reloaded flow');
assert.equal(reloadedDevNode.config.deviceId, String(targetDevice._id), 'Device canonical Mongo _id must be restored');
assert.equal(reloadedDevNode.config.deviceCode, targetDevice.deviceId, 'Device code must be restored');
assert.equal(reloadedDevNode.config.metric, 'batteryV', 'Device metric must be restored');
console.log('  ✓ Device node config restored successfully:', reloadedDevNode.config);

const reloadedGwNode = reloaded.versions[0]?.graphJson?.nodes?.find(n => n.type === 'Gateway');
assert.ok(reloadedGwNode, 'Gateway node must exist in reloaded flow');
assert.equal(reloadedGwNode.config.gatewayId, String(targetGateway._id), 'Gateway canonical Mongo _id must be restored');
assert.equal(reloadedGwNode.config.gatewayCode, targetGateway.gatewayId, 'Gateway code must be restored');
console.log('  ✓ Gateway node config restored successfully:', reloadedGwNode.config);

// Clean up test flow
await fetch(`http://localhost:3000/api/v1/correlation-models/${createdModel._id}`, {
  method: 'DELETE',
  headers
});
console.log('  ✓ Temporary test model cleaned up.');

console.log('\n======================================================');
console.log('ALL DEVICE & GATEWAY CORRELATION E2E CHECKS PASSED!');
console.log('======================================================');

