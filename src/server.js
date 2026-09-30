import http from 'node:http';
import cron from 'node-cron';
import { Server as SocketIOServer } from 'socket.io';
import { connectDb, disconnectDb } from './config/db.js';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { refreshMissingDataHealth } from './services/health.service.js';
import { startMqttIngestion } from './services/mqtt.service.js';
import { PlatformAdmin } from './models/index.js';
import bcrypt from 'bcryptjs';

await connectDb();
const app = createApp();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });
app.locals.emitEvent = (name, payload) => {
  io.emit(name, payload);
  if (payload?.projectId) io.to(`project:${payload.projectId}`).emit(name, payload);
};
const mqttClient = startMqttIngestion({ emit: app.locals.emitEvent });

io.on('connection', (socket) => {
  socket.on('project.join', (projectId) => socket.join(`project:${projectId}`));
  socket.on('project.leave', (projectId) => socket.leave(`project:${projectId}`));
});

if (env.enableMissingDataWatch) {
  cron.schedule(env.missingDataCron, async () => {
    try { await refreshMissingDataHealth({ emit: app.locals.emitEvent }); }
    catch (err) { console.error('[health-watch]', err); }
  });
}

async function bootstrapAdmin() {
  const { PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_NAME, PLATFORM_ADMIN_PASSWORD } = process.env;
  if (PLATFORM_ADMIN_EMAIL && PLATFORM_ADMIN_PASSWORD) {
    const existing = await PlatformAdmin.findOne({ email: PLATFORM_ADMIN_EMAIL.toLowerCase() });
    if (!existing) {
      await PlatformAdmin.create({
        email: PLATFORM_ADMIN_EMAIL.toLowerCase(),
        name: PLATFORM_ADMIN_NAME || 'Platform Admin',
        passwordHash: await bcrypt.hash(PLATFORM_ADMIN_PASSWORD, 12),
        status: 'ACTIVE'
      });
      console.log(`[bootstrap] Created Platform Admin: ${PLATFORM_ADMIN_EMAIL}`);
    }
  }
}
await bootstrapAdmin();

server.listen(env.port, () => console.log(`GeoNexa API listening on http://localhost:${env.port}  docs: http://localhost:${env.port}/api-docs`));

async function shutdown(signal) {
  console.log(`\n${signal}: shutting down`);
  if (mqttClient) mqttClient.end(true);
  server.close(async () => { await disconnectDb(); process.exit(0); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
