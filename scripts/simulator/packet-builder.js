/**
 * Generic Telemetry v1 Packet Builder
 *
 * Assembles physical readings into the exact Generic Telemetry v1 JSON contract.
 */
export function buildTelemetryPacket({
  deviceCode,
  gatewayCode = undefined,
  timestamp = new Date().toISOString(),
  messageId,
  sequenceNumber,
  readings,
  health = undefined
}) {
  const packet = {
    schemaVersion: 1,
    deviceCode,
    timestamp,
    messageId,
    sequenceNumber,
    readings
  };

  if (gatewayCode) {
    packet.gatewayCode = gatewayCode;
  }

  if (health && typeof health === 'object') {
    packet.health = health;
  }

  return packet;
}

