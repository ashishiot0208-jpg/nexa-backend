import fs from 'node:fs';
import path from 'node:path';

export const VALID_GENERATOR_TYPES = new Set([
  'fixed',
  'range',
  'noise',
  'stable',
  'gradual_rise',
  'gradual_fall',
  'spike',
  'recovery'
]);

export const VALID_SCENARIOS = new Set([
  'NORMAL',
  'GRADUAL_RISE',
  'SPIKE',
  'RECOVERY',
  'OFFLINE',
  'LOW_BATTERY',
  'POOR_SIGNAL'
]);

export function resolveApiKey(rawKey, deviceCode) {
  let key = rawKey;
  if (typeof key === 'string') {
    key = key.trim();
    // Support ${VAR_NAME} interpolation
    const envMatch = key.match(/^\$\{([a-zA-Z0-9_]+)\}$/);
    if (envMatch) {
      const varName = envMatch[1];
      key = process.env[varName] || '';
    }
  }
  if (!key) {
    // Fallback to environment variables
    const sanitizedDevCode = (deviceCode || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    key = process.env.NEXAIQ_DEVICE_API_KEY ||
          process.env[`DEVICE_API_KEY_${sanitizedDevCode}`] ||
          process.env.DEVICE_API_KEY ||
          undefined;
  }
  return key ? String(key).trim() : undefined;
}

/**
 * Validates and normalizes simulator configuration.
 * Throws an Error with a clear message if validation fails.
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[Simulator Config] Configuration must be a JSON object');
  }

  // 1. Device Code
  if (!config.deviceCode || typeof config.deviceCode !== 'string' || !config.deviceCode.trim()) {
    throw new Error('[Simulator Config] deviceCode is required and must be a non-empty string');
  }

  // 2. Gateway Code (optional)
  if (config.gatewayCode !== undefined && (typeof config.gatewayCode !== 'string' || !config.gatewayCode.trim())) {
    throw new Error('[Simulator Config] gatewayCode must be a non-empty string when provided');
  }

  // 3. Interval
  const intervalMs = config.intervalMs !== undefined ? Number(config.intervalMs) : 10000;
  if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    throw new Error(`[Simulator Config] intervalMs must be a positive number of at least 100ms (got: ${config.intervalMs})`);
  }

  // 4. Scenario
  const scenario = (config.scenario || 'NORMAL').toUpperCase().trim();
  if (!VALID_SCENARIOS.has(scenario)) {
    throw new Error(`[Simulator Config] Unsupported scenario '${config.scenario}'. Supported scenarios: ${[...VALID_SCENARIOS].join(', ')}`);
  }

  // 5. Slots
  if (!Array.isArray(config.slots) || config.slots.length === 0) {
    throw new Error('[Simulator Config] slots must be a non-empty array of slot configurations');
  }

  const seenSlots = new Set();
  const normalizedSlots = [];

  for (let sIdx = 0; sIdx < config.slots.length; sIdx++) {
    const s = config.slots[sIdx];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`[Simulator Config] Slot at index ${sIdx} must be an object`);
    }

    const slotNum = Number(s.slot);
    if (!Number.isInteger(slotNum) || slotNum < 1) {
      throw new Error(`[Simulator Config] slot must be a positive integer at index ${sIdx} (got: ${s.slot})`);
    }

    if (seenSlots.has(slotNum)) {
      throw new Error(`[Simulator Config] Duplicate slot number ${slotNum} defined in configuration`);
    }
    seenSlots.add(slotNum);

    // Channels in slot
    if (!Array.isArray(s.channels) || s.channels.length === 0) {
      throw new Error(`[Simulator Config] Slot ${slotNum} must have a non-empty channels array`);
    }

    const seenChannels = new Set();
    const normalizedChannels = [];

    for (let cIdx = 0; cIdx < s.channels.length; cIdx++) {
      const ch = s.channels[cIdx];
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) {
        throw new Error(`[Simulator Config] Channel at index ${cIdx} in slot ${slotNum} must be an object`);
      }

      if (!ch.channelCode || typeof ch.channelCode !== 'string' || !ch.channelCode.trim()) {
        throw new Error(`[Simulator Config] channelCode is required for channel at index ${cIdx} in slot ${slotNum}`);
      }

      const lowerCode = ch.channelCode.trim().toLowerCase();
      if (seenChannels.has(lowerCode)) {
        throw new Error(`[Simulator Config] Duplicate channelCode '${ch.channelCode}' in slot ${slotNum}`);
      }
      seenChannels.add(lowerCode);

      // Generator
      const gen = ch.generator || { type: 'stable', baseline: 0.0 };
      if (!gen || typeof gen !== 'object' || Array.isArray(gen)) {
        throw new Error(`[Simulator Config] generator must be an object for channel '${ch.channelCode}' in slot ${slotNum}`);
      }

      const genType = (gen.type || 'stable').toLowerCase().trim();
      if (!VALID_GENERATOR_TYPES.has(genType)) {
        throw new Error(`[Simulator Config] Unsupported generator type '${gen.type}' for channel '${ch.channelCode}' in slot ${slotNum}. Supported types: ${[...VALID_GENERATOR_TYPES].join(', ')}`);
      }

      normalizedChannels.push({
        channelCode: ch.channelCode.trim(),
        generator: {
          ...gen,
          type: genType
        }
      });
    }

    normalizedSlots.push({
      slot: slotNum,
      channels: normalizedChannels
    });
  }

  // Return sanitized configuration
  return {
    deviceCode: config.deviceCode.trim(),
    gatewayCode: config.gatewayCode ? config.gatewayCode.trim() : undefined,
    intervalMs,
    scenario,
    slots: normalizedSlots,
    health: config.health !== undefined ? config.health : true,
    apiKey: resolveApiKey(config.apiKey, config.deviceCode),
    targetUrl: config.targetUrl ? String(config.targetUrl).trim() : undefined,
    maxRetries: config.maxRetries !== undefined ? Number(config.maxRetries) : 3,
    retryDelayMs: config.retryDelayMs !== undefined ? Number(config.retryDelayMs) : 1000
  };
}

/**
 * Loads a configuration from a JSON file.
 */
export function loadConfigFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`[Simulator Config] Configuration file not found at: ${resolved}`);
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`[Simulator Config] Invalid JSON in configuration file: ${err.message}`);
  }
  return validateConfig(parsed);
}

