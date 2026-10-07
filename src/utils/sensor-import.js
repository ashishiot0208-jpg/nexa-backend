export function deriveDisplayName(code) {
  if (!code) return '';
  return String(code)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function isDuplicate(item, existing) {
  const itemType = String(item.type || '').trim().toLowerCase();
  const exType = String(existing.type || '').trim().toLowerCase();
  if (itemType !== exType) return false;

  const itemName = String(item.name || '').trim().toLowerCase();
  const exName = String(existing.name || '').trim().toLowerCase();
  if (itemName !== exName) return false;

  const itemModel = String(item.model || '').trim().toLowerCase();
  const exModel = String(existing.model || '').trim().toLowerCase();

  // If model is blank on either, it's considered duplicate by (same type AND same name)
  if (!itemModel || !exModel) {
    return true;
  }

  return itemModel === exModel;
}

export function evaluateSensorBatch(sensors, existingSensors, existingSensorTypes) {
  const typeMap = new Map();
  for (const t of existingSensorTypes) {
    typeMap.set(String(t.code || '').trim().toLowerCase(), t);
  }

  const validItemsInFileSoFar = [];
  const rows = [];
  const missingTypesMap = new Map();

  for (let index = 0; index < sensors.length; index++) {
    const item = sensors[index];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rows.push({
        index,
        status: 'INVALID',
        name: `Row ${index + 1}`,
        type: '-',
        typeName: '-',
        model: '-',
        signal_type: '-',
        channelsCount: 0,
        issue: 'Invalid sensor object format'
      });
      continue;
    }

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    const signal_type = typeof item.signal_type === 'string' ? item.signal_type.trim() : '';
    const model = item.model != null ? String(item.model).trim() : '';
    const channels = Array.isArray(item.channels) ? item.channels : null;

    // 1. Required fields check
    const missingFields = [];
    if (!name) missingFields.push('name');
    if (!type) missingFields.push('type');
    if (!signal_type) missingFields.push('signal_type');
    if (!channels) {
      missingFields.push('channels');
    } else if (channels.length === 0) {
      missingFields.push('at least one channel');
    }

    if (missingFields.length > 0) {
      rows.push({
        index,
        status: 'INVALID',
        name: name || `Row ${index + 1}`,
        type: type || '-',
        typeName: '-',
        model: model || '-',
        signal_type: signal_type || '-',
        channelsCount: channels ? channels.length : 0,
        issue: `Missing required field(s): ${missingFields.join(', ')}`
      });
      continue;
    }

    // 2. Channels validation
    const measurementsSeen = new Set();
    const channelIssues = [];
    const cleanChannels = [];

    for (let cIdx = 0; cIdx < channels.length; cIdx++) {
      const ch = channels[cIdx];
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) {
        channelIssues.push(`Channel #${cIdx + 1} is invalid`);
        continue;
      }

      const measurement = typeof ch.measurement === 'string' ? ch.measurement.trim() : '';
      const unit = typeof ch.unit === 'string' ? ch.unit.trim() : '';

      if (!measurement) {
        channelIssues.push(`Channel #${cIdx + 1} missing measurement`);
      } else {
        const lowerMeas = measurement.toLowerCase();
        if (measurementsSeen.has(lowerMeas)) {
          channelIssues.push(`Duplicate measurement: "${measurement}"`);
        } else {
          measurementsSeen.add(lowerMeas);
        }
      }

      if (!unit) {
        channelIssues.push(`Channel #${cIdx + 1} missing unit`);
      }

      const rangeMin = ch.range_min !== undefined && ch.range_min !== null && ch.range_min !== '' ? Number(ch.range_min) : null;
      const rangeMax = ch.range_max !== undefined && ch.range_max !== null && ch.range_max !== '' ? Number(ch.range_max) : null;
      if (rangeMin !== null && isNaN(rangeMin)) {
        channelIssues.push(`Channel "${measurement || cIdx + 1}": range_min must be numeric`);
      }
      if (rangeMax !== null && isNaN(rangeMax)) {
        channelIssues.push(`Channel "${measurement || cIdx + 1}": range_max must be numeric`);
      }
      if (rangeMin !== null && rangeMax !== null && !isNaN(rangeMin) && !isNaN(rangeMax) && rangeMin > rangeMax) {
        channelIssues.push(`Channel "${measurement || cIdx + 1}": range_min must be <= range_max`);
      }

      const resVal = ch.resolution_value !== undefined && ch.resolution_value !== null && ch.resolution_value !== '' ? Number(ch.resolution_value) : null;
      if (resVal !== null) {
        if (isNaN(resVal) || resVal < 0) {
          channelIssues.push(`Channel "${measurement || cIdx + 1}": resolution_value must be >= 0`);
        }
      }

      const accVal = ch.accuracy_value !== undefined && ch.accuracy_value !== null && ch.accuracy_value !== '' ? Number(ch.accuracy_value) : null;
      if (accVal !== null) {
        if (isNaN(accVal) || accVal < 0) {
          channelIssues.push(`Channel "${measurement || cIdx + 1}": accuracy_value must be >= 0`);
        }
      }

      cleanChannels.push({
        measurement,
        unit,
        range_min: rangeMin,
        range_max: rangeMax,
        resolution_value: resVal,
        resolution_unit: ch.resolution_unit ? String(ch.resolution_unit).trim() : null,
        accuracy_value: accVal,
        accuracy_unit: ch.accuracy_unit ? String(ch.accuracy_unit).trim() : null
      });
    }

    if (channelIssues.length > 0) {
      rows.push({
        index,
        status: 'INVALID',
        name,
        type,
        typeName: '-',
        model: model || '-',
        signal_type,
        channelsCount: channels.length,
        issue: channelIssues.join('; ')
      });
      continue;
    }

    // 3. Sensor Type validation
    const lowerTypeCode = type.toLowerCase();
    const sensorTypeObj = typeMap.get(lowerTypeCode);

    if (!sensorTypeObj) {
      const derivedName = deriveDisplayName(type);
      missingTypesMap.set(lowerTypeCode, {
        code: lowerTypeCode,
        name: derivedName
      });

      rows.push({
        index,
        status: 'MISSING TYPE',
        name,
        type,
        typeName: derivedName,
        model: model || '-',
        signal_type,
        channelsCount: channels.length,
        issue: 'Sensor Type does not exist'
      });
      continue;
    }

    if (sensorTypeObj.status === 'inactive') {
      rows.push({
        index,
        status: 'TYPE INACTIVE',
        name,
        type,
        typeName: sensorTypeObj.name || deriveDisplayName(type),
        model: model || '-',
        signal_type,
        channelsCount: channels.length,
        issue: 'Sensor Type exists but is inactive'
      });
      continue;
    }

    // 4. Duplicate checks
    const currentItem = { name, type: sensorTypeObj.code, model, signal_type };

    // Duplicate in file?
    let dupInFile = false;
    for (const prev of validItemsInFileSoFar) {
      if (isDuplicate(currentItem, prev)) {
        dupInFile = true;
        break;
      }
    }

    if (dupInFile) {
      rows.push({
        index,
        status: 'DUPLICATE',
        name,
        type,
        typeName: sensorTypeObj.name,
        model: model || '-',
        signal_type,
        channelsCount: channels.length,
        issue: 'Duplicate Sensor inside uploaded file'
      });
      continue;
    }

    // Duplicate in catalogue?
    let dupInCatalogue = false;
    for (const existing of existingSensors) {
      if (isDuplicate(currentItem, existing)) {
        dupInCatalogue = true;
        break;
      }
    }

    if (dupInCatalogue) {
      rows.push({
        index,
        status: 'DUPLICATE',
        name,
        type,
        typeName: sensorTypeObj.name,
        model: model || '-',
        signal_type,
        channelsCount: channels.length,
        issue: 'Possible existing Sensor'
      });
      continue;
    }

    // Row is VALID
    validItemsInFileSoFar.push(currentItem);
    rows.push({
      index,
      status: 'VALID',
      name,
      type: sensorTypeObj.code,
      typeName: sensorTypeObj.name,
      model: model || '-',
      signal_type,
      channelsCount: cleanChannels.length,
      channels: cleanChannels,
      issue: '-',
      cleanData: {
        name,
        type: sensorTypeObj.code,
        model: model || undefined,
        signal_type,
        channels: cleanChannels,
        status: 'active'
      }
    });
  }

  const validCount = rows.filter(r => r.status === 'VALID').length;
  const duplicateCount = rows.filter(r => r.status === 'DUPLICATE').length;
  const missingTypeCount = rows.filter(r => r.status === 'MISSING TYPE').length;
  const inactiveTypeCount = rows.filter(r => r.status === 'TYPE INACTIVE').length;
  const invalidCount = rows.filter(r => r.status === 'INVALID').length;

  return {
    summary: {
      total: rows.length,
      validCount,
      duplicateCount,
      missingTypeCount,
      inactiveTypeCount,
      invalidCount
    },
    rows,
    missingTypes: Array.from(missingTypesMap.values())
  };
}
