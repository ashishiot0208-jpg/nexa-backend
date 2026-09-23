# Angular integration

## Development proxy

Keep the Angular proxy pointed to the backend:

```json
{
  "/api": {
    "target": "http://localhost:3000",
    "secure": false,
    "changeOrigin": true
  },
  "/socket.io": {
    "target": "http://localhost:3000",
    "ws": true,
    "secure": false
  }
}
```

## Auth

1. `POST /api/v1/auth/login`
2. Store returned JWT.
3. Send `Authorization: Bearer <token>` with user APIs.

## First Angular milestones

Existing foundation endpoints are preserved. Add services incrementally for:

- `GET /projects/:id/overview`
- `GET /projects/:id/instruments`
- `GET /projects/:id/devices`
- `GET /projects/:id/telemetry`
- `GET /projects/:id/trends`
- `GET /projects/:id/latest-state`
- `GET /projects/:id/alarms`
- `GET /projects/:id/decisions`

## Realtime

Install `socket.io-client` in Angular and join a project room:

```ts
const socket = io('http://localhost:3000');
socket.emit('project.join', projectId);
socket.on('telemetry.updated', event => { /* refresh relevant signals */ });
socket.on('decision.created', event => { /* refresh status */ });
socket.on('alarm.changed', event => { /* refresh alarm badge/list */ });
socket.on('device.health_changed', event => { /* refresh device health */ });
```

The backend remains authoritative; use realtime events as invalidation/update signals rather than recalculating engineering states in Angular.
