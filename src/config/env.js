import 'dotenv/config';

const splitCsv = (value) => String(value || '').split(',').map((x) => x.trim()).filter(Boolean);

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://139.59.41.28:27017/geonexa',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-this-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigins: splitCsv(process.env.CORS_ORIGINS || 'http://localhost:4200'),
  deviceKeyHeader: (process.env.DEVICE_KEY_HEADER || 'x-device-key').toLowerCase(),
  missingDataCron: process.env.MISSING_DATA_CRON || '*/5 * * * *',
  enableMissingDataWatch: String(process.env.ENABLE_MISSING_DATA_WATCH || 'true') === 'true',
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 20),
  enableMqtt: String(process.env.ENABLE_MQTT || 'false') === 'true',
  mqttUrl: process.env.MQTT_URL || 'mqtt://127.0.0.1:1883',
  mqttUsername: process.env.MQTT_USERNAME || '',
  mqttPassword: process.env.MQTT_PASSWORD || '',
  mqttTopic: process.env.MQTT_TOPIC || 'geonexa/+/+/+/telemetry'
};
