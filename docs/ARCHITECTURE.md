# Architecture

## Runtime chain

```text
Device / Logger
      │
      ├── HTTP POST /telemetry/ingest
      └── MQTT geonexa/{tenant}/{project}/{device}/telemetry (optional)
      │
      ▼
Device authentication
      ▼
Raw packet / field persistence
      ▼
Normalization + quality checks
      ▼
Calibration / baseline / engineering derivation
      ▼
Deterministic rules
      ▼
S0–S4 deterministic severity floor
      +
H0–H4 monitoring health
      +
0–100 confidence
      ▼
Immutable decision snapshot
      ▼
Alarm workflow + notifications + audit
      ▼
Socket.IO event + Angular UI
```

## MongoDB collections

The backend separates domain concepts even though they share one MongoDB cluster in Phase 1:

- Identity: organizations, users, organisation memberships, project memberships
- Configuration: use-case templates, instrument catalogue, dashboard templates, rule sets
- Project: projects, sites, zones
- Assets: instruments, sensor channels, devices, calibration versions, baseline versions, device commands
- Telemetry: raw readings, derived readings, device health samples, latest state
- Decisions: decision snapshots, alarms, alarm events, notifications, audit events
- Advanced: dashboards/versions, correlation models/backtests, cameras/media, documents, logbook, reports

## Safety boundary

Engineering truth stays on the backend. Angular renders results and submits controlled workflow actions; it does not calculate authoritative severity, clear thresholds, calibration results or TARP actions.

The Decision service deliberately sets final severity to at least the deterministic `severityFloor`. Future correlation/AI services may add evidence or raise severity, but must not lower that floor.

## Phase-1 decisions

This package is a modular monolith, not a network microservice per table. The service boundaries are kept explicit so ingestion, telemetry queries, correlation, reporting and notifications can be extracted later without rewriting the domain model.

## Storage note

MongoDB is used for relational-style configuration and telemetry for this requested implementation. Binary uploads are stored under `uploads/` with MongoDB metadata. For high-volume production deployments, move media to S3-compatible storage and evaluate dedicated time-series storage/partitioning according to project retention and query volume.
