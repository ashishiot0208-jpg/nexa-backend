#!/usr/bin/env node

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  Site,
  Zone,
  Instrument,
  Device,
  ProjectGateway,
  GeospatialLayer,
  GeospatialFeature,
  User,
  OrganizationMember
} from '../src/models/index.js';

let server;
const TEST_PORT = 3109;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(TEST_PORT, '127.0.0.1', () => {
      resolve();
    });
  });
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    throw new Error(message);
  }
  console.log(`[PASS] ${message}`);
}

async function run() {
  console.log('====================================================');
  console.log('GEOSPATIAL LAYER REMOVAL & PERMISSIONS VERIFICATION');
  console.log('====================================================');

  await mongoose.connect(env.mongoUri);
  await startServer();

  try {
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    assert(!!project, `Found project LAN-PRO-01 (${project?._id})`);

    const orgId = project.organizationId.toString();
    const projectId = project._id.toString();

    // 1. Get an active user
    const user = await User.findOne({ organizationId: project.organizationId, status: 'ACTIVE' }) || await User.findOne({ status: 'ACTIVE' });
    assert(!!user, `Found active user (${user?._id})`);

    const adminToken = jwt.sign(
      { organizationId: orgId, organizationRole: 'ADMINISTRATOR' },
      env.jwtSecret,
      { subject: user._id.toString(), expiresIn: '1h' }
    );

    // 2. Count monitoring assets BEFORE delete
    const instCountBefore = await Instrument.countDocuments({ projectId, status: { $ne: 'DELETED' } });
    const devCountBefore = await Device.countDocuments({ projectId, status: { $ne: 'DELETED' } });
    const gwCountBefore = await ProjectGateway.countDocuments({ projectId });
    const siteCountBefore = await Site.countDocuments({ projectId });
    const zoneCountBefore = await Zone.countDocuments({ projectId });

    // 3. Find current layers
    const drawingLayer = await GeospatialLayer.findOne({ projectId, name: 'geonexa_engineering_drawing' });
    assert(!!drawingLayer, 'Found geonexa_engineering_drawing layer');
    const sectionLayer = await GeospatialLayer.findOne({ projectId, name: 'geonexa_engineering_section_AA' });
    assert(!!sectionLayer, 'Found geonexa_engineering_section_AA layer');

    const drawingFeaturesCountBefore = await GeospatialFeature.countDocuments({ layerId: drawingLayer._id });
    const sectionFeaturesCountBefore = await GeospatialFeature.countDocuments({ layerId: sectionLayer._id });
    console.log(`Drawing features count: ${drawingFeaturesCountBefore}, Section features count: ${sectionFeaturesCountBefore}`);

    // 4. Test VIEWER permission (should be rejected 403)
    const viewerToken = jwt.sign(
      { organizationId: orgId, organizationRole: 'VIEWER' },
      env.jwtSecret,
      { subject: user._id.toString(), expiresIn: '1h' }
    );
    const viewerRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/geospatial/${drawingLayer._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${viewerToken}` }
    });
    assert(viewerRes.status === 403, `Viewer cannot delete geometry layer (got ${viewerRes.status} 403 Forbidden)`);

    // 5. Test Project Isolation (wrong project ID should be rejected 404)
    const fakeProjectId = new mongoose.Types.ObjectId().toString();
    const wrongProjectRes = await fetch(`${BASE_URL}/api/v1/projects/${fakeProjectId}/geospatial/${drawingLayer._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(wrongProjectRes.status === 404, `Cross-project/wrong project delete rejected (got ${wrongProjectRes.status} 404)`);

    // 6. Delete drawingLayer as admin
    const deleteDrawingRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/geospatial/${drawingLayer._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(deleteDrawingRes.status === 200, `Drawing layer deletion succeeded (got ${deleteDrawingRes.status} 200)`);
    const deleteDrawingJson = await deleteDrawingRes.json();
    assert(deleteDrawingJson.ok === true, 'Response ok is true');
    assert(deleteDrawingJson.featuresDeleted === drawingFeaturesCountBefore, `Deleted exactly ${drawingFeaturesCountBefore} features`);

    // Verify drawingLayer is gone from DB
    const drawingLayerAfter = await GeospatialLayer.findById(drawingLayer._id);
    assert(!drawingLayerAfter, 'Drawing layer permanently removed from DB');
    const drawingFeaturesAfter = await GeospatialFeature.countDocuments({ layerId: drawingLayer._id });
    assert(drawingFeaturesAfter === 0, 'Drawing features permanently removed from DB');

    // 7. Delete sectionLayer as admin
    const deleteSectionRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/geospatial/${sectionLayer._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(deleteSectionRes.status === 200, `Section layer deletion succeeded (got ${deleteSectionRes.status} 200)`);
    const deleteSectionJson = await deleteSectionRes.json();
    assert(deleteSectionJson.featuresDeleted === sectionFeaturesCountBefore, `Deleted exactly ${sectionFeaturesCountBefore} features`);

    // Verify sectionLayer is gone from DB
    const sectionLayerAfter = await GeospatialLayer.findById(sectionLayer._id);
    assert(!sectionLayerAfter, 'Section layer permanently removed from DB');
    const sectionFeaturesAfter = await GeospatialFeature.countDocuments({ layerId: sectionLayer._id });
    assert(sectionFeaturesAfter === 0, 'Section features permanently removed from DB');

    // 8. Re-import drawing as STRUCTURE and section as SECTION per prompt test case instructions!
    const drawingImportRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/geospatial/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'geonexa_engineering_drawing',
        category: 'STRUCTURE',
        sourceType: 'GEOJSON',
        sourceFile: 'geonexa_drawing.geojson',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [[88.3625, 22.5721], [88.3653, 22.5721], [88.3653, 22.5732], [88.3625, 22.5732], [88.3625, 22.5721]]
              ]
            },
            properties: { name: 'Dam Structure Outline', description: 'Re-imported as STRUCTURE' }
          },
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [88.3627, 22.57265], [88.3634, 22.57272], [88.3642, 22.57278], [88.365, 22.57284]
              ]
            },
            properties: { name: 'Dam Crest Line', description: 'Re-imported as STRUCTURE' }
          }
        ]
      })
    });
    assert(drawingImportRes.status === 201, `Drawing re-imported as STRUCTURE (got ${drawingImportRes.status} 201)`);
    const newDrawing = await GeospatialLayer.findOne({ projectId, name: 'geonexa_engineering_drawing' });
    assert(newDrawing?.category === 'STRUCTURE', 'New drawing classification is STRUCTURE');

    const sectionImportRes = await fetch(`${BASE_URL}/api/v1/projects/${projectId}/geospatial/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'geonexa_engineering_section_AA',
        category: 'SECTION',
        sourceType: 'GEOJSON',
        sourceFile: 'geonexa_section.geojson',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [88.3628, 22.5723, 105],
                [88.3634, 22.57245, 102],
                [88.3639, 22.5726, 98],
                [88.3645, 22.57275, 95],
                [88.365, 22.5729, 92]
              ]
            },
            properties: { name: 'Section A-A', description: 'Re-imported as SECTION' }
          }
        ]
      })
    });
    assert(sectionImportRes.status === 201, `Section re-imported as SECTION (got ${sectionImportRes.status} 201)`);
    const newSection = await GeospatialLayer.findOne({ projectId, name: 'geonexa_engineering_section_AA' });
    assert(newSection?.category === 'SECTION', 'New section classification is SECTION');

    // 9. Verify monitoring assets remained completely unchanged
    const instCountAfter = await Instrument.countDocuments({ projectId, status: { $ne: 'DELETED' } });
    const devCountAfter = await Device.countDocuments({ projectId, status: { $ne: 'DELETED' } });
    const gwCountAfter = await ProjectGateway.countDocuments({ projectId });
    const siteCountAfter = await Site.countDocuments({ projectId });
    const zoneCountAfter = await Zone.countDocuments({ projectId });

    assert(instCountBefore === instCountAfter, `Instruments unchanged (${instCountAfter}/${instCountBefore})`);
    assert(devCountBefore === devCountAfter, `Devices unchanged (${devCountAfter}/${devCountBefore})`);
    assert(gwCountBefore === gwCountAfter, `Gateways unchanged (${gwCountAfter}/${gwCountBefore})`);
    assert(siteCountBefore === siteCountAfter, `Sites unchanged (${siteCountAfter}/${siteCountBefore})`);
    assert(zoneCountBefore === zoneCountAfter, `Zones unchanged (${zoneCountAfter}/${zoneCountBefore})`);

    console.log('====================================================');
    console.log('ALL GEOMETRY REMOVAL & PERMISSION TESTS PASSED');
    console.log('====================================================');
  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
