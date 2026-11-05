# NexaIQ Physical Field Device Simulator (Phase GT-2)

The NexaIQ Field Device Simulator simulates real physical field loggers (such as ESP32, STM32, Campbell Scientific, or industrial data loggers) as closely as practical.

When real physical hardware is connected later, firmware only replaces synthetic value generation with ADC/Modbus/RS485 sensor reading; the packet format, HTTP transport, and backend commissioning derivation remain identical.

---

## 1. Core Architecture Rule

```text
Field Device / Simulator
        ↓  (HTTP POST JSON)
/api/v1/telemetry/ingest
        ↓
Device Validation (Device.findOne({ deviceId }))
        ↓
Commissioning
        ↓
Device Slot (SensorDeviceMapping)
        ↓
Mapped Instrument
        ↓
Channel Code (SensorChannel.code)
        ↓
Calibration (scale + offset)
        ↓
Baseline (delta calculation)
        ↓
LatestState (upsert)
        ↓
Severity Evaluation
        ↓
Alarm Generation
        ↓
MongoDB Persistence (RawReading, DerivedReading, Alarm)
```

> **IMPORTANT:**
> The simulator **never writes directly to MongoDB**. It does not import or create `RawReading`, `DerivedReading`, `LatestState`, `Alarm`, or `DeviceTelemetry` models. It communicates strictly as an external physical client over HTTP.

---

## 2. Generic Telemetry v1 Contract

Every transmission adheres strictly to the Generic Telemetry v1 packet structure:

```json
{
  "schemaVersion": 1,
  "deviceCode": "DEV-001",
  "gatewayCode": "GW-001",
  "timestamp": "2026-11-05T13:00:00.000Z",
  "messageId": "DEV-001-A1B2-000145",
  "sequenceNumber": 145,
  "readings": [
    {
      "slot": 1,
      "channels": [
        { "channelCode": "X_DISP", "value": 2.503 },
        { "channelCode": "Y_DISP", "value": 1.101 },
        { "channelCode": "TEMP", "value": 27.42 }
      ]
    },
    {
      "slot": 2,
      "channels": [
        { "channelCode": "PORE_PRESSURE", "value": 42.61 },
        { "channelCode": "TEMP", "value": 24.12 }
      ]
    }
  ],
  "health": {
    "batteryV": 3.92,
    "rssiDbm": -78,
    "network": "4G",
    "internalTempC": 31.5,
    "faultBits": []
  }
}
```

---

## 3. Configuration Structure

Simulator configuration describes only physical-level device properties:

```json
{
  "deviceCode": "DEV-001",
  "gatewayCode": "GW-001",
  "intervalMs": 10000,
  "scenario": "NORMAL",
  "health": {
    "batteryV": 3.92,
    "rssiDbm": -78,
    "network": "4G",
    "internalTempC": 31.5
  },
  "slots": [
    {
      "slot": 1,
      "channels": [
        {
          "channelCode": "X_DISP",
          "generator": { "type": "stable", "baseline": 2.5, "noise": 0.05 }
        },
        {
          "channelCode": "TEMP",
          "generator": { "type": "range", "min": 24.0, "max": 28.0 }
        }
      ]
    }
  ]
}
```

The configuration contains **no engineering logic**:
- No units
- No calibration slopes or intercepts
- No baselines
- No severity rules
- No MongoDB ObjectIds or project IDs

All engineering meaning is resolved dynamically by NexaIQ Commissioning.

---

## 4. Reusable Generators

1. **`stable`**: Centers around `baseline` with small random noise (`± noise`).
2. **`range`**: Performs a bounded random walk within `[min, max]`.
3. **`gradual_rise`**: Steadily increments by `step` on each sample up to `max`.
4. **`gradual_fall`**: Steadily decrements by `step` on each sample down to `min`.
5. **`spike`**: Transmits normal baseline values, periodically spiking to `spikeValue` for `spikeDuration` samples before returning to baseline.
6. **`recovery`**: Starts at an offset value and smoothly decays back to `baseline`.
7. **`fixed`**: Holds a constant configured value.

---

## 5. Demo Scenarios

- **`NORMAL`**: All channels emit normal baseline/stable values. Health parameters remain healthy.
- **`GRADUAL_RISE`**: Incrementally elevates readings on each transmission.
- **`SPIKE`**: Emits an anomalous high value (crossing severity thresholds), then returns to baseline.
- **`RECOVERY`**: Demonstrates system stabilization after an event.
- **`OFFLINE`**: Pauses transmissions to emulate device communication loss. (Device health evaluates offline status based on missing telemetry; no manual database edits).
- **`LOW_BATTERY`**: Drops battery voltage to 3.12V and sets `LOW_VOLTAGE` fault bit.
- **`POOR_SIGNAL`**: Drops RSSI to -108 dBm.

---

## 6. Sequence Numbers, Message IDs & Network Retries

- **Sequence Number**: Starts at a configured initial sequence and increments monotonically with every new packet.
- **Message ID**: Formatted as `<deviceCode>-<sessionId>-<sequenceNumber>` (e.g. `DEV-001-A1B2-000145`).
- **Network Retry**: If an HTTP transmission fails due to network loss or server error (HTTP 5xx):
  - Retries up to `maxRetries` times with exponential backoff.
  - The **exact same packet** is resent: identical `messageId`, `sequenceNumber`, `timestamp`, and `readings`.
  - Values are **never regenerated** during retries.
  - The backend's idempotency layer safely identifies retried packets and ignores duplicates.

---

## 7. CLI Usage

Run default multi-slot demo device:
```bash
npm run simulator
```

Run with custom config:
```bash
npm run simulator -- --config scripts/simulator/configs/bridge-logger.json
```

Run specific scenario:
```bash
npm run simulator -- --config scripts/simulator/configs/dev-001.json --scenario SPIKE
```

Send 1 packet and exit (useful for testing):
```bash
npm run simulator -- --config scripts/simulator/configs/dev-001.json --once
```

Send N packets and exit:
```bash
npm run simulator -- --config scripts/simulator/configs/dev-001.json --count 5
```

Override interval:
```bash
npm run simulator -- --interval 5000
```

