/**
 * Deployment-Safe Idempotent Database Index Migration
 *
 * Ensures:
 * 1. Obsolete rawreadings index ({ deviceId: 1, messageId: 1, channelCode: 1 }) is safely dropped if present.
 * 2. Target rawreadings index ({ deviceId: 1, messageId: 1, instrumentId: 1, channelCode: 1 }) is created if missing.
 * 3. sensorchannels unique index ({ instrumentId: 1, code: 1 }) is upgraded to case-insensitive collation if safe.
 * 4. Safe to run multiple times (idempotent).
 * 5. Never deletes or modifies documents.
 * 6. Never drops unrelated indexes.
 */

export async function migrateRawReadingIndex(db) {
  if (!db) {
    throw new Error('[index-migration] Cannot run index migration: db connection is undefined');
  }

  const rawreadingsCol = db.collection('rawreadings');
  const existingIndexes = await rawreadingsCol.indexes().catch(() => []);
  let droppedOld = false;
  let createdNew = false;

  // 1. Check for obsolete RawReading index
  const oldIndex = existingIndexes.find(idx =>
    idx.name === 'deviceId_1_messageId_1_channelCode_1' ||
    (idx.key && idx.key.deviceId === 1 && idx.key.messageId === 1 && idx.key.channelCode === 1 && !idx.key.instrumentId)
  );

  if (oldIndex) {
    console.log(`[index-migration] Found obsolete index '${oldIndex.name}' on rawreadings. Safely dropping...`);
    await rawreadingsCol.dropIndex(oldIndex.name);
    droppedOld = true;
    console.log(`[index-migration] Successfully dropped obsolete index '${oldIndex.name}'.`);
  } else {
    console.log(`[index-migration] Obsolete index 'deviceId_1_messageId_1_channelCode_1' not present on rawreadings.`);
  }

  // 2. Check for target multi-slot RawReading index
  const newIndex = existingIndexes.find(idx =>
    idx.name === 'deviceId_1_messageId_1_instrumentId_1_channelCode_1' ||
    (idx.key && idx.key.deviceId === 1 && idx.key.messageId === 1 && idx.key.instrumentId === 1 && idx.key.channelCode === 1)
  );

  if (!newIndex) {
    console.log(`[index-migration] Creating target unique index { deviceId: 1, messageId: 1, instrumentId: 1, channelCode: 1 } on rawreadings...`);
    await rawreadingsCol.createIndex(
      { deviceId: 1, messageId: 1, instrumentId: 1, channelCode: 1 },
      { unique: true, sparse: true, background: true }
    );
    createdNew = true;
    console.log(`[index-migration] Successfully created target index on rawreadings.`);
  } else {
    console.log(`[index-migration] Target unique index 'deviceId_1_messageId_1_instrumentId_1_channelCode_1' already exists on rawreadings.`);
  }

  return { droppedOld, createdNew };
}

export async function migrateSensorChannelIndex(db) {
  if (!db) {
    throw new Error('[index-migration] Cannot run index migration: db connection is undefined');
  }

  const sensorchannelsCol = db.collection('sensorchannels');
  const existingIndexes = await sensorchannelsCol.indexes().catch(() => []);
  let upgraded = false;

  const scIndex = existingIndexes.find(idx =>
    idx.name === 'instrumentId_1_code_1' ||
    (idx.key && idx.key.instrumentId === 1 && idx.key.code === 1)
  );

  const hasCaseInsensitiveCollation = scIndex?.collation?.strength === 2;

  if (scIndex && !hasCaseInsensitiveCollation) {
    console.log(`[index-migration] Found non-collated index '${scIndex.name}' on sensorchannels. Inspecting for potential duplicates before collation upgrade...`);
    const duplicates = await sensorchannelsCol.aggregate([
      { $group: { _id: { instrumentId: '$instrumentId', code: { $toLower: '$code' } }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();

    if (duplicates.length > 0) {
      console.warn(`[index-migration] Warning: Found ${duplicates.length} case-only duplicate group(s) in sensorchannels. Preserving existing records without dropping index.`);
    } else {
      await sensorchannelsCol.dropIndex(scIndex.name);
      await sensorchannelsCol.createIndex(
        { instrumentId: 1, code: 1 },
        { unique: true, collation: { locale: 'en', strength: 2 }, background: true }
      );
      upgraded = true;
      console.log(`[index-migration] Successfully upgraded 'instrumentId_1_code_1' to case-insensitive collation on sensorchannels.`);
    }
  } else if (!scIndex) {
    await sensorchannelsCol.createIndex(
      { instrumentId: 1, code: 1 },
      { unique: true, collation: { locale: 'en', strength: 2 }, background: true }
    );
    upgraded = true;
    console.log(`[index-migration] Created case-insensitive 'instrumentId_1_code_1' index on sensorchannels.`);
  } else {
    console.log(`[index-migration] Index 'instrumentId_1_code_1' on sensorchannels already has case-insensitive collation.`);
  }

  return { upgraded };
}

export async function ensureIndexesMigrated(db) {
  console.log('[index-migration] Running deployment-safe index synchronization...');
  const rawResult = await migrateRawReadingIndex(db);
  const scResult = await migrateSensorChannelIndex(db);
  console.log('[index-migration] Index synchronization complete.');
  return { rawResult, scResult };
}

