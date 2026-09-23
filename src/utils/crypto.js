import crypto from 'node:crypto';

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
export const objectIdString = (value) => value?.toString?.() || String(value || '');
