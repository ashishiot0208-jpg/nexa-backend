import { Device } from '../models/index.js';
import { env } from '../config/env.js';
import { sha256 } from '../utils/crypto.js';
import { ApiError } from '../utils/api-error.js';

export async function requireDevice(req, _res, next) {
  try {
    const key = req.headers[env.deviceKeyHeader];
    if (!key) throw new ApiError(401, `Missing ${env.deviceKeyHeader} header`);
    const deviceId = req.body?.deviceId || req.params?.deviceId;
    if (!deviceId) throw new ApiError(400, 'deviceId is required');
    const device = await Device.findOne({ deviceId }).exec();
    if (!device || !device.apiKeyHash || device.apiKeyHash !== sha256(key)) throw new ApiError(401, 'Invalid device credentials');
    req.device = device;
    next();
  } catch (err) { next(err); }
}
