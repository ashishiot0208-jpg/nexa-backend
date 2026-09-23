# API endpoints

All user endpoints require `Authorization: Bearer <JWT>` unless marked device/public.

## Authentication and discovery

```text
POST /api/v1/auth/login
GET  /api/v1/auth/me
GET  /api/v1/health                         public
GET  /api/v1/use-case-templates
GET  /api/v1/instrument-catalog
GET  /api/v1/configuration/:useCaseCode
```

## Projects / hierarchy

```text
GET   /api/v1/projects
POST  /api/v1/projects
GET   /api/v1/projects/:projectId
PATCH /api/v1/projects/:projectId
GET   /api/v1/projects/:projectId/overview
POST  /api/v1/projects/:projectId/sites
POST  /api/v1/projects/:projectId/zones
```

## Instruments / devices

```text
GET  /api/v1/projects/:projectId/instruments
POST /api/v1/projects/:projectId/instruments
GET  /api/v1/instruments/:id
POST /api/v1/instruments/:id/calibrations
POST /api/v1/instruments/:id/baselines
POST /api/v1/instruments/:id/commission
GET  /api/v1/projects/:projectId/devices
POST /api/v1/projects/:projectId/devices
POST /api/v1/devices/:id/rotate-key
PATCH /api/v1/channels/:id/device
```

## Telemetry

```text
POST /api/v1/telemetry/ingest                    device API key
POST /api/v1/projects/:projectId/telemetry/manual
GET  /api/v1/projects/:projectId/telemetry
GET  /api/v1/projects/:projectId/trends
GET  /api/v1/projects/:projectId/latest-state
GET  /api/v1/projects/:projectId/telemetry/export.csv
```

## Decisions / alarms

```text
GET  /api/v1/projects/:projectId/decisions
GET  /api/v1/decisions/:id
GET  /api/v1/decisions/:id/trace
GET  /api/v1/projects/:projectId/alarms
GET  /api/v1/alarms/:id
POST /api/v1/alarms/:id/transition
POST /api/v1/alarms/:id/acknowledge
POST /api/v1/alarms/:id/actions
GET  /api/v1/notifications
```

## Rule management

```text
GET  /api/v1/projects/:projectId/rule-set
POST /api/v1/projects/:projectId/rule-sets/versions
POST /api/v1/rule-sets/:id/approve
POST /api/v1/projects/:projectId/rule-sets/:id/activate
```

## Dashboards

```text
GET  /api/v1/dashboards?projectId=...
POST /api/v1/dashboards
PUT  /api/v1/dashboards/:id/draft
POST /api/v1/dashboards/:id/publish
POST /api/v1/dashboards/:id/clone
POST /api/v1/widget-data/query
```

## Correlation Studio

```text
GET  /api/v1/projects/:projectId/correlation-models
POST /api/v1/correlation-models
PUT  /api/v1/correlation-models/:id/versions/:v
POST /api/v1/correlation-models/:id/backtests
GET  /api/v1/backtests/:id
POST /api/v1/correlation-models/:id/versions/:v/submit
POST /api/v1/correlation-models/:id/versions/:v/approve
POST /api/v1/correlation-models/:id/versions/:v/activate
```

## Vision / documents / logbook / reports

```text
GET  /api/v1/cameras?projectId=...
POST /api/v1/cameras
GET  /api/v1/cameras/:id/snapshots
POST /api/v1/cameras/:id/snapshots               multipart file
GET  /api/v1/media/:id/file
POST /api/v1/media/:id/annotations

GET  /api/v1/projects/:projectId/documents
POST /api/v1/projects/:projectId/documents       multipart file
GET  /api/v1/documents/:id/file

GET  /api/v1/projects/:projectId/logbook
POST /api/v1/projects/:projectId/logbook

GET  /api/v1/projects/:projectId/reports
POST /api/v1/projects/:projectId/reports
GET  /api/v1/reports/:id
GET  /api/v1/reports/:id/download
```

## Device operations

```text
POST /api/v1/device/:mongoDeviceId/commands
GET  /api/v1/device/:deviceId/commands/pending       device API key
POST /api/v1/device/:deviceId/commands/:commandId/ack device API key
```

## Administration

```text
GET  /api/v1/admin/users
POST /api/v1/admin/users
POST /api/v1/admin/projects/:projectId/members
GET  /api/v1/admin/audit
```
