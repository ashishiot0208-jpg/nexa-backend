import mongoose from 'mongoose';
import 'dotenv/config';
import { Sensor } from '../src/models/index.js';

async function parseRange(rangeStr) {
  if (!rangeStr) return { min: null, max: null };
  const str = rangeStr.toLowerCase().trim();
  
  // "0 to 1000 kPa" -> min: 0, max: 1000
  let match = str.match(/^(-?\d+(?:\.\d+)?)\s*to\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return { min: parseFloat(match[1]), max: parseFloat(match[2]) };
  }
  
  // "up to 150 mm" -> min: null, max: 150
  match = str.match(/up to\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return { min: null, max: parseFloat(match[1]) };
  }

  // "-15 to 15°" -> min: -15, max: 15
  match = str.match(/^(-?\d+(?:\.\d+)?)\s*to\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return { min: parseFloat(match[1]), max: parseFloat(match[2]) };
  }

  return null; // unparseable
}

async function parseValueAndUnit(str, measurementUnit) {
  if (!str) return { value: null, unit: null };
  // extract value (can include sign for ± but we drop it for value itself, user said "Do NOT put ± sign inside accuracy_value")
  // e.g. "±0.25% FSR" -> value: 0.25, unit: "% FSR"
  // "0.1 kPa" -> value: 0.1, unit: "kPa"
  const match = str.match(/^[±]?\s*(\d+(?:\.\d+)?)\s*(.*)$/);
  if (match) {
    let unit = match[2].trim();
    if (unit.toLowerCase() === 'same as measurement unit' || unit === '') {
      unit = measurementUnit;
    }
    return { value: parseFloat(match[1]), unit: unit || null };
  }
  return null;
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const sensors = await Sensor.find({});
  let migrated = 0;
  let unparseable = 0;
  let unparseableRecords = [];

  for (const sensor of sensors) {
    let needsSave = false;
    let recordParseError = false;

    for (let i = 0; i < sensor.channels.length; i++) {
      const channel = sensor.channels[i];
      if (channel.range || channel.resolution || channel.accuracy) {
        // Needs migration
        const rangeObj = await parseRange(channel.range);
        const resObj = await parseValueAndUnit(channel.resolution, channel.unit);
        const accObj = await parseValueAndUnit(channel.accuracy, channel.unit);

        if (rangeObj === null && channel.range) recordParseError = true;
        if (resObj === null && channel.resolution) recordParseError = true;
        if (accObj === null && channel.accuracy) recordParseError = true;

        if (!recordParseError) {
          if (rangeObj) {
            channel.range_min = rangeObj.min;
            channel.range_max = rangeObj.max;
          }
          if (resObj) {
            channel.resolution_value = resObj.value;
            channel.resolution_unit = resObj.unit;
          }
          if (accObj) {
            channel.accuracy_value = accObj.value;
            channel.accuracy_unit = accObj.unit;
          }
          
          // clear old fields
          channel.range = undefined;
          channel.resolution = undefined;
          channel.accuracy = undefined;
          needsSave = true;
        }
      }
    }

    if (recordParseError) {
      unparseable++;
      unparseableRecords.push({
        uid: sensor.uid,
        name: sensor.name,
        channels: sensor.channels.map(c => ({
          range: c.range,
          resolution: c.resolution,
          accuracy: c.accuracy
        }))
      });
    } else if (needsSave) {
      // mongoose doesn't let you unset fields in an array element easily if they are not in schema anymore,
      // but they are removed from our schema so saving will just drop them if strict is on, or we can use markModified
      sensor.markModified('channels');
      await sensor.save();
      migrated++;
    }
  }

  console.log('Migration Complete.');
  console.log(`Migrated successfully: ${migrated}`);
  console.log(`Unparseable records: ${unparseable}`);
  if (unparseable > 0) {
    console.log('Unparseable details:', JSON.stringify(unparseableRecords, null, 2));
  }
  process.exit(0);
}

run().catch(console.error);
