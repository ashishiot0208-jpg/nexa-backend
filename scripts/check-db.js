import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

async function check() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB:', env.mongoUri);
    
    const db = mongoose.connection.db;
    const projects = await db.collection('projects').find({}).toArray();
    console.log('Total projects in DB:', projects.length);
    projects.forEach(p => {
      console.log(`- Project ID: ${p._id}, Name: ${p.name}, Code: ${p.code}`);
    });

    const geospatialLayers = await db.collection('geospatiallayers').find({}).toArray();
    console.log('Total geospatial layers in DB:', geospatialLayers.length);
    geospatialLayers.forEach(l => {
      console.log(`- Layer ID: ${l._id}, Name: ${l.name}, Category: ${l.category}, Project: ${l.projectId}`);
    });

    const geospatialFeatures = await db.collection('geospatialfeatures').find({}).toArray();
    console.log('Total geospatial features in DB:', geospatialFeatures.length);

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error connecting to DB:', err);
  }
}

check();
