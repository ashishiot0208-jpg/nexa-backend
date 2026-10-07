export function deriveDisplayName(code) {
  if (!code) return '';
  return String(code)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function isDeviceDuplicate(item, existing) {
  const itemType = String(item.type || '').trim().toLowerCase();
  const exType = String(existing.type || '').trim().toLowerCase();
  if (itemType !== exType) return false;

  const itemName = String(item.name || '').trim().toLowerCase();
  const exName = String(existing.name || '').trim().toLowerCase();
  if (itemName !== exName) return false;

  const itemModel = String(item.model || '').trim().toLowerCase();
  const exModel = String(existing.model || '').trim().toLowerCase();

  // If model is blank on either, considered duplicate by (same name AND same type)
  if (!itemModel || !exModel) {
    return true;
  }

  return itemModel === exModel;
}

export function evaluateDeviceBatch(devices, existingDevices, existingDeviceTypes, activeSignalTypesSet) {
  const typeMap = new Map();
  for (const t of existingDeviceTypes) {
    typeMap.set(String(t.code || '').trim().toLowerCase(), t);
  }

  const validItemsInFileSoFar = [];
  const rows = [];
  const missingTypesMap = new Map();

  for (let index = 0; index < devices.length; index++) {
    const item = devices[index];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rows.push({
        index,
        status: 'INVALID',
        name: `Row ${index + 1}`,
        type: '-',
        typeName: '-',
        model: '-',
        supported_signal_types: [],
        max_channels: 0,
        communication: '-',
        issue: 'Invalid device object format'
      });
      continue;
    }

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    const model = item.model != null ? String(item.model).trim() : '';
    const supported_signal_types = Array.isArray(item.supported_signal_types) ? item.supported_signal_types : null;
    const max_channels = item.max_channels !== undefined && item.max_channels !== null ? Number(item.max_channels) : null;
    const communication = typeof item.communication === 'string' ? item.communication.trim() : '';

    // 1. Required fields check
    const missingFields = [];
    if (!name) missingFields.push('name');
    if (!type) missingFields.push('type');
    if (!supported_signal_types) {
      missingFields.push('supported_signal_types');
    } else if (supported_signal_types.length === 0) {
      missingFields.push('at least one supported signal type');
    }
    if (max_channels === null || isNaN(max_channels)) {
      missingFields.push('max_channels');
    }
    if (!communication) missingFields.push('communication');

    if (missingFields.length > 0) {
      rows.push({
        index,
        status: 'INVALID',
        name: name || `Row ${index + 1}`,
        type: type || '-',
        typeName: '-',
        model: model || '-',
        supported_signal_types: supported_signal_types || [],
        max_channels: max_channels || 0,
        communication: communication || '-',
        issue: `Missing required field(s): ${missingFields.join(', ')}`
      });
      continue;
    }

    // 2. max_channels validation: integer >= 1
    if (!Number.isInteger(max_channels) || max_channels < 1) {
      rows.push({
        index,
        status: 'INVALID',
        name,
        type,
        typeName: '-',
        model: model || '-',
        supported_signal_types: supported_signal_types || [],
        max_channels,
        communication,
        issue: 'max_channels must be an integer greater than or equal to 1'
      });
      continue;
    }

    // 3. supported_signal_types checks (no blank, no duplicates)
    const cleanSignals = [];
    const signalsSeen = new Set();
    let hasBlankSignal = false;
    let hasDuplicateSignal = false;

    for (const sig of supported_signal_types) {
      if (typeof sig !== 'string' || !sig.trim()) {
        hasBlankSignal = true;
        continue;
      }
      const trimmed = sig.trim().toLowerCase();
      if (signalsSeen.has(trimmed)) {
        hasDuplicateSignal = true;
      } else {
        signalsSeen.add(trimmed);
        cleanSignals.push(trimmed);
      }
    }

    if (hasBlankSignal) {
      rows.push({
        index,
        status: 'INVALID',
        name,
        type,
        typeName: '-',
        model: model || '-',
        supported_signal_types,
        max_channels,
        communication,
        issue: 'supported_signal_types contains blank or invalid signal values'
      });
      continue;
    }

    if (hasDuplicateSignal) {
      rows.push({
        index,
        status: 'INVALID',
        name,
        type,
        typeName: '-',
        model: model || '-',
        supported_signal_types,
        max_channels,
        communication,
        issue: 'supported_signal_types contains duplicate signal values'
      });
      continue;
    }

    // 4. Validate signal types against active Sensor.signal_type
    const invalidSignals = cleanSignals.filter(sig => !activeSignalTypesSet.has(sig));
    if (invalidSignals.length > 0) {
      rows.push({
        index,
        status: 'INVALID SIGNAL',
        name,
        type,
        typeName: '-',
        model: model || '-',
        supported_signal_types: cleanSignals,
        max_channels,
        communication,
        issue: `Signal Type not available in Sensor Catalogue: ${invalidSignals.join(', ')}`
      });
      continue;
    }

    // 5. Device Type validation
    const lowerTypeCode = type.toLowerCase();
    const deviceTypeObj = typeMap.get(lowerTypeCode);

    if (!deviceTypeObj) {
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
        supported_signal_types: cleanSignals,
        max_channels,
        communication,
        issue: 'Device Type does not exist'
      });
      continue;
    }

    if (deviceTypeObj.status === 'inactive') {
      rows.push({
        index,
        status: 'TYPE INACTIVE',
        name,
        type,
        typeName: deviceTypeObj.name || deriveDisplayName(type),
        model: model || '-',
        supported_signal_types: cleanSignals,
        max_channels,
        communication,
        issue: 'Device Type exists but is inactive'
      });
      continue;
    }

    // 6. Duplicate checks
    const currentItem = { name, type: deviceTypeObj.code, model, supported_signal_types: cleanSignals, max_channels, communication };

    // Duplicate in file?
    let dupInFile = false;
    for (const prev of validItemsInFileSoFar) {
      if (isDeviceDuplicate(currentItem, prev)) {
        dupInFile = true;
        break;
      }
    }

    if (dupInFile) {
      rows.push({
        index,
        status: 'DUPLICATE',
        name,
        type: deviceTypeObj.code,
        typeName: deviceTypeObj.name,
        model: model || '-',
        supported_signal_types: cleanSignals,
        max_channels,
        communication,
        issue: 'Duplicate Device inside uploaded file'
      });
      continue;
    }

    // Duplicate in catalogue?
    let dupInCatalogue = false;
    for (const existing of existingDevices) {
      if (isDeviceDuplicate(currentItem, existing)) {
        dupInCatalogue = true;
        break;
      }
    }

    if (dupInCatalogue) {
      rows.push({
        index,
        status: 'DUPLICATE',
        name,
        type: deviceTypeObj.code,
        typeName: deviceTypeObj.name,
        model: model || '-',
        supported_signal_types: cleanSignals,
        max_channels,
        communication,
        issue: 'Possible existing Device'
      });
      continue;
    }

    // Row is VALID
    validItemsInFileSoFar.push(currentItem);
    rows.push({
      index,
      status: 'VALID',
      name,
      type: deviceTypeObj.code,
      typeName: deviceTypeObj.name,
      model: model || '-',
      supported_signal_types: cleanSignals,
      max_channels,
      communication,
      issue: '-',
      cleanData: {
        name,
        type: deviceTypeObj.code,
        model: model || undefined,
        supported_signal_types: cleanSignals,
        max_channels,
        communication,
        status: 'active'
      }
    });
  }

  const validCount = rows.filter(r => r.status === 'VALID').length;
  const duplicateCount = rows.filter(r => r.status === 'DUPLICATE').length;
  const missingTypeCount = rows.filter(r => r.status === 'MISSING TYPE').length;
  const inactiveTypeCount = rows.filter(r => r.status === 'TYPE INACTIVE').length;
  const invalidSignalCount = rows.filter(r => r.status === 'INVALID SIGNAL').length;
  const invalidCount = rows.filter(r => r.status === 'INVALID').length;

  return {
    summary: {
      total: rows.length,
      validCount,
      duplicateCount,
      missingTypeCount,
      inactiveTypeCount,
      invalidSignalCount,
      invalidCount
    },
    rows,
    missingTypes: Array.from(missingTypesMap.values())
  };
}
