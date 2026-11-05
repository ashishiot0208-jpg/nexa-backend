import { Device } from '../models/index.js';
import { env } from '../config/env.js';
import { sha256 } from '../utils/crypto.js';
import { ApiError } from '../utils/api-error.js';

/**
 * Authenticates an incoming physical device API key.
 *
 * 1. Checks that rawKey is provided -> throws 401 if missing.
 * 2. Hashes key with SHA-256 and finds the corresponding Device.
 *    If no device matches apiKeyHash -> throws 401 'Invalid device credentials'.
 * 3. If expectedDeviceId is supplied:
 *    Ensures case-insensitive match with device.deviceId.
 *    If mismatch -> throws 403 Forbidden to prevent device impersonation/spoofing.
 *
 * @param {string} rawKey - The plain-text device API key from request headers
 * @param {string} [expectedDeviceId] - The deviceCode or deviceId claimed in payload/params
 * @returns {Promise<Device>} The authenticated Device mongoose document
 */
export async function authenticateDeviceKey(rawKey, expectedDeviceId) {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
    throw new ApiError(401, `Missing ${env.deviceKeyHeader} header`);
  }

  const trimmedKey = rawKey.trim();
  const keyHash = sha256(trimmedKey);

  const device = await Device.findOne({
    apiKeyHash: keyHash
  }).exec();

  if (!device || !device.apiKeyHash) {
    throw new ApiError(401, 'Invalid device credentials');
  }

  if (expectedDeviceId) {
    const expected = String(expectedDeviceId).trim().toLowerCase();
    const actual = String(device.deviceId).trim().toLowerCase();
    if (actual !== expected) {
      throw new ApiError(403, `Device credential mismatch: API key belongs to '${device.deviceId}' not '${expectedDeviceId}'`);
    }
  }

  return device;
}

/**
 * Middleware for routes where deviceId is in params or body (e.g. device command routes).
 */
export async function requireDevice(req, _res, next) {
  try {
    const key = req.headers[env.deviceKeyHeader];
    const deviceId = req.params?.deviceId || req.body?.deviceId || req.body?.deviceCode;
    if (!deviceId) throw new ApiError(400, 'deviceId is required');
    const device = await authenticateDeviceKey(key, deviceId);
    req.device = device;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware for telemetry ingestion endpoints.
 * Extracts deviceCode from packet body and enforces device key authentication.
 */
export async function requireDeviceAuth(req, _res, next) {
  try {
    const key = req.headers[env.deviceKeyHeader];
    const deviceCode = req.body?.deviceCode || req.body?.deviceId || req.params?.deviceId;
    if (!deviceCode) {
      // Prioritize checking key first so missing key always produces 401
      if (!key) {
        throw new ApiError(401, `Missing ${env.deviceKeyHeader} header`);
      }
      throw new ApiError(400, 'deviceCode (or deviceId) is required');
    }
    const device = await authenticateDeviceKey(key, deviceCode);
    req.device = device;
    next();
  } catch (err) {
    next(err);
  }
}
