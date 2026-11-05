import EventEmitter from 'node:events';
import { validateConfig } from './config.js';
import { ValueGenerator, HealthGenerator } from './generators.js';
import { SimulatorState } from './state.js';
import { buildTelemetryPacket } from './packet-builder.js';
import { HttpTransport } from './transport.js';

/**
 * NexaIQ Physical Field Device Simulator
 *
 * Emulates an industrial logger/data acquisition unit sending
 * Generic Telemetry v1 packets over HTTP.
 */
export class DeviceSimulator extends EventEmitter {
  constructor(rawConfig, options = {}) {
    super();
    this.config = validateConfig(rawConfig);
    this.options = options;

    this.deviceCode = this.config.deviceCode;
    this.gatewayCode = this.config.gatewayCode;
    this.intervalMs = this.config.intervalMs;
    this.scenario = this.config.scenario;

    // 1. Initialize State Tracker
    this.state = new SimulatorState(this.deviceCode, {
      stateFilePath: options.stateFilePath || null,
      initialSeq: options.initialSeq !== undefined ? options.initialSeq : 100
    });

    // 2. Initialize Value Generators for all slots & channels
    this.generators = new Map();
    for (const slotConf of this.config.slots) {
      for (const chConf of slotConf.channels) {
        const key = `${slotConf.slot}:${chConf.channelCode}`;
        this.generators.set(key, new ValueGenerator(chConf.generator));
      }
    }

    // 3. Initialize Health Generator
    this.healthGen = new HealthGenerator(this.config.health);

    // 4. Initialize HTTP Transport
    this.targetUrl = options.targetUrl || this.config.targetUrl || 'http://127.0.0.1:3000/api/v1/telemetry/ingest';
    this.transport = new HttpTransport({
      targetUrl: this.targetUrl,
      apiKey: this.config.apiKey,
      maxRetries: this.config.maxRetries,
      retryDelayMs: this.config.retryDelayMs,
      fetchFn: options.fetchFn || globalThis.fetch
    });

    this.timer = null;
    this.isRunning = false;
    this.lastPacket = null;
  }

  setScenario(newScenario) {
    this.scenario = String(newScenario).toUpperCase().trim();
    this.emit('scenarioChanged', this.scenario);
  }

  /**
   * Generates a new Generic Telemetry v1 packet with incremented sequence number.
   */
  generatePacket() {
    const { sequenceNumber, messageId } = this.state.nextMessage();

    // Collect physical readings per slot
    const readings = [];
    for (const slotConf of this.config.slots) {
      const slotNum = slotConf.slot;
      const channels = [];

      for (const chConf of slotConf.channels) {
        const key = `${slotNum}:${chConf.channelCode}`;
        const gen = this.generators.get(key);
        const value = gen.next(this.scenario);
        channels.push({
          channelCode: chConf.channelCode,
          value
        });
      }

      readings.push({
        slot: slotNum,
        channels
      });
    }

    // Generate health
    const health = this.healthGen.next(this.scenario);

    const packet = buildTelemetryPacket({
      deviceCode: this.deviceCode,
      gatewayCode: this.gatewayCode,
      timestamp: new Date().toISOString(),
      messageId,
      sequenceNumber,
      readings,
      health: health || undefined
    });

    this.lastPacket = packet;
    return packet;
  }

  /**
   * Executes a single simulation transmission step.
   */
  async step() {
    // OFFLINE simulation scenario: device paused transmitting
    if (this.scenario === 'OFFLINE') {
      const skipInfo = {
        deviceCode: this.deviceCode,
        skipped: true,
        reason: 'OFFLINE_SCENARIO'
      };
      this.emit('skipped', skipInfo);
      return skipInfo;
    }

    const packet = this.generatePacket();
    this.emit('packetSending', packet);

    const result = await this.transport.send(packet, {
      onRetry: (retryEvent) => {
        this.emit('retry', {
          deviceCode: this.deviceCode,
          ...retryEvent
        });
      }
    });

    if (result.success) {
      this.emit('packetSuccess', { packet, result });
    } else {
      this.emit('packetError', { packet, result, error: result.error });
    }

    return { packet, result };
  }

  /**
   * Starts continuous background simulation.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emit('started', {
      deviceCode: this.deviceCode,
      gatewayCode: this.gatewayCode,
      intervalMs: this.intervalMs,
      scenario: this.scenario,
      targetUrl: this.targetUrl,
      slotsCount: this.config.slots.length,
      channelsCount: this.generators.size
    });

    // Execute first step immediately
    this.step().catch(() => {});

    // Schedule subsequent steps
    this.timer = setInterval(() => {
      this.step().catch(() => {});
    }, this.intervalMs);
  }

  /**
   * Stops simulation cleanly.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.state.persist();
    this.emit('stopped', { deviceCode: this.deviceCode });
  }
}

