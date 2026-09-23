# Seed data

`npm run seed` resets the demo database and creates meaningful operational data.

## NH-10 slope project

Assets:
- Automatic inclinometer
- Piezometer
- Rain gauge
- Tiltmeter
- 4G logger `GW-018`
- Camera metadata
- Two logbook events

Telemetry:
- 48 samples at 15-minute intervals
- Early samples are stable
- Recent samples deliberately increase displacement, pore pressure and rainfall
- Device health degrades slightly near the latest samples

The data passes through the same ingestion/quality/engineering/rule/decision code used by live HTTP/MQTT telemetry. This produces real derived readings, decisions, alarms, latest-state rows and in-app notifications.

## Tunnel project

`TN-01` contains convergence + tilt data with 16 recent 30-minute telemetry cycles.

## Dam project

`DM-01` contains pore-pressure + inclinometer data with 16 recent 30-minute telemetry cycles.

## Rules

The seeded rules are intentionally demonstration thresholds. They are not general geotechnical safety criteria and must not be deployed as project engineering limits.
