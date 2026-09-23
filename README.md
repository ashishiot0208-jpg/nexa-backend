# GeoNexa Backend — Node.js + Express.js + MongoDB

A runnable Phase-1 backend for the GeoNexa geotechnical monitoring platform described by the supplied SRS and designed to replace the earlier Fastify/PostgreSQL backend used by the Angular foundation.

## Stack

- Node.js 20+
- Express.js 5
- MongoDB 7 + Mongoose
- JWT authentication + bcrypt
- Socket.IO real-time events
- HTTP telemetry ingestion
- Optional MQTT ingestion
- PDFKit report generation
- Multer file/media uploads
- Swagger UI at `/api-docs`

## Implemented domains

- Organisation users, roles and project membership
- Use-case templates and instrument catalogue
- Real project creation wizard persistence
- Site/zone hierarchy
- Instruments, sensor channels, calibration and baselines
- Devices/loggers, API keys, health and command queue
- Immutable raw telemetry and processed/derived readings
- Data-quality validation
- Engineering calibration, baseline delta, rate and resultant calculations
- Deterministic S0–S4 rule evaluation
- H0–H4 monitoring health
- Confidence calculation and immutable decision snapshots
- Alarm lifecycle, acknowledgement, investigation/action/normalization/closure and audit
- Historical telemetry, cursor pagination, trends and CSV export
- Project overview/latest-state APIs
- Dashboard draft/publish/clone/versioning
- Correlation model validation, approval/activation and working Phase-1 backtest
- Camera metadata and snapshot upload
- Project documents and engineering logbook
- PDF project summary reports
- In-app notification records
- Append-only audit events
- Socket.IO events for telemetry, decisions, alarms and device health

## Quick start

### 1. Start MongoDB

```bash
docker compose up -d mongo
```

Mongo Express is optional and available with:

```bash
docker compose up -d
```

Then open `http://localhost:8081` for Mongo Express.

### 2. Configure the backend

```bash
cp .env.example .env
```

For local development, the defaults work with the Docker MongoDB service if you change:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/geonexa
```

### 3. Install packages

```bash
npm install
```

### 4. Seed realistic demo data

```bash
npm run seed
```

This creates three working monitoring projects, users, devices, instruments, rule sets, dashboards and processed telemetry.

### 5. Run the API

```bash
npm run dev
```

API: `http://localhost:3000/api/v1`

Swagger: `http://localhost:3000/api-docs`

Health check: `http://localhost:3000/api/v1/health`

## Demo login accounts

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@geonexa.local` | `Admin@123` |
| Engineer | `engineer@geonexa.local` | `Engineer@123` |
| Operator | `operator@geonexa.local` | `Operator@123` |
| Viewer | `viewer@geonexa.local` | `Viewer@123` |

## Seeded projects

- `NH-10` — Landslide / Slope Monitoring
- `TN-01` — Tunnel Monitoring
- `DM-01` — Dam Monitoring

The NH-10 project contains 48 recent telemetry cycles with an engineered movement/pore-pressure escalation near the end of the sequence, so the rule/decision/alarm flow has meaningful data instead of static placeholder cards.

## Seed device keys

These are demo-only credentials for telemetry ingestion:

```text
GW-018   : DEMO-GW-018-KEY
GW-TN-01 : DEMO-TN-01-KEY
GW-DM-01 : DEMO-DM-01-KEY
```

Example device upload:

```bash
curl -X POST http://localhost:3000/api/v1/telemetry/ingest \
  -H 'Content-Type: application/json' \
  -H 'x-device-key: DEMO-GW-018-KEY' \
  -d '{
    "deviceId":"GW-018",
    "messageId":"LIVE-0001",
    "sampleTime":"2026-09-21T16:45:00+05:30",
    "channels":{
      "inc_x":9.2,
      "inc_y":6.1,
      "inc_temp":30.1,
      "pore_pressure":124.5,
      "rain_15m":8.4,
      "tilt_x":0.34,
      "tilt_y":0.16,
      "tilt_temp":30.0
    },
    "health":{"batteryV":3.61,"rssiDbm":-78,"network":"4G"}
  }'
```

## Angular compatibility

The current Angular foundation can keep these endpoints without changing its existing project-creation service:

```text
POST /api/v1/auth/login
GET  /api/v1/use-case-templates
GET  /api/v1/instrument-catalog
GET  /api/v1/configuration/:code
GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/projects/:projectId
```

A new operational overview endpoint is also provided:

```text
GET /api/v1/projects/:projectId/overview
```

For Angular local development, leave `CORS_ORIGINS=http://localhost:4200`.

## Important production boundary

The seeded thresholds are **demonstration rules only**. Real S3/S4 limits, calibration formulas and TARP actions must be replaced with project-approved engineering values and an approval process before field deployment. AI/correlation evidence is never allowed to reduce the deterministic severity floor.

See `docs/ARCHITECTURE.md`, `docs/API_ENDPOINTS.md`, `docs/SEED_DATA.md`, and `docs/ANGULAR_INTEGRATION.md`.
