import mqtt from 'mqtt';
import { env } from '../config/env.js';
import { Device } from '../models/index.js';
import { ingestTelemetry } from './telemetry.service.js';

export function startMqttIngestion({ emit = () => {} } = {}) {
  if (!env.enableMqtt) return null;
  const client = mqtt.connect(env.mqttUrl, {
    username: env.mqttUsername || undefined,
    password: env.mqttPassword || undefined,
    reconnectPeriod: 5000
  });
  client.on('connect', () => {
    console.log(`[mqtt] connected ${env.mqttUrl}; subscribing ${env.mqttTopic}`);
    client.subscribe(env.mqttTopic, { qos: 1 });
  });
  client.on('message', async (topic, payloadBuffer) => {
    try {
      const parts = topic.split('/');
      const deviceId = parts.at(-2);
      const payload = JSON.parse(payloadBuffer.toString('utf8'));
      await ingestTelemetry({ ...payload, deviceCode: payload.deviceCode || payload.deviceId || deviceId }, { emit, source: 'DEVICE' });
    } catch (err) {
      console.error('[mqtt] ingest failed:', err.message);
    }
  });
  client.on('error', (err) => console.error('[mqtt]', err.message));
  return client;
}
