/**
 * Generic Synthetic Reading & Health Generators for Field Device Simulator
 *
 * All generators are 100% project-agnostic.
 * Channel-specific behavior is driven strictly by generator configuration.
 */

export class ValueGenerator {
  constructor(config = {}) {
    this.type = (config.type || 'stable').toLowerCase();
    this.precision = config.precision !== undefined ? Number(config.precision) : 3;

    // Parameters
    this.baseline = config.baseline !== undefined ? Number(config.baseline) : (config.center !== undefined ? Number(config.center) : 0.0);
    this.value = config.value !== undefined ? Number(config.value) : this.baseline;
    this.min = config.min !== undefined ? Number(config.min) : -100.0;
    this.max = config.max !== undefined ? Number(config.max) : 100.0;
    this.noise = config.noise !== undefined ? Number(config.noise) : 0.05;
    this.step = config.step !== undefined ? Number(config.step) : 0.1;
    this.spikeValue = config.spikeValue !== undefined ? Number(config.spikeValue) : (this.baseline + 10.0);
    this.spikeInterval = config.spikeInterval !== undefined ? Math.max(2, Number(config.spikeInterval)) : 5;
    this.spikeDuration = config.spikeDuration !== undefined ? Math.max(1, Number(config.spikeDuration)) : 1;

    // Runtime state
    this.currentValue = config.initial !== undefined ? Number(config.initial) : this.baseline;
    this.tickCount = 0;
  }

  next(scenario = 'NORMAL') {
    this.tickCount++;
    let val = this.computeRaw(scenario);

    // Apply Scenario Modifiers if applicable
    val = this.applyScenario(val, scenario);

    // Format precision
    return Number(val.toFixed(this.precision));
  }

  computeRaw(scenario) {
    switch (this.type) {
      case 'fixed': {
        return this.value;
      }

      case 'range': {
        const center = (this.min + this.max) / 2;
        const halfWidth = (this.max - this.min) / 2;
        // Bounded random walk
        const delta = (Math.random() * 2 - 1) * (halfWidth * 0.1);
        this.currentValue = Math.min(this.max, Math.max(this.min, this.currentValue + delta));
        return this.currentValue;
      }

      case 'stable':
      case 'noise': {
        // Center around baseline with small noise
        const jitter = (Math.random() * 2 - 1) * this.noise;
        return this.baseline + jitter;
      }

      case 'gradual_rise': {
        this.currentValue += this.step;
        if (this.currentValue > this.max) {
          this.currentValue = this.max;
        }
        const jitter = (Math.random() * 2 - 1) * (this.noise * 0.5);
        return Math.min(this.max, this.currentValue + jitter);
      }

      case 'gradual_fall': {
        this.currentValue -= this.step;
        if (this.currentValue < this.min) {
          this.currentValue = this.min;
        }
        const jitter = (Math.random() * 2 - 1) * (this.noise * 0.5);
        return Math.max(this.min, this.currentValue + jitter);
      }

      case 'spike': {
        // Normal base, spikes every spikeInterval ticks for spikeDuration ticks
        const isSpiking = (this.tickCount % this.spikeInterval) < this.spikeDuration;
        if (isSpiking) {
          return this.spikeValue;
        }
        const jitter = (Math.random() * 2 - 1) * this.noise;
        return this.baseline + jitter;
      }

      case 'recovery': {
        // Exponentially decay deviation back toward baseline
        const diff = this.currentValue - this.baseline;
        this.currentValue = this.baseline + (diff * 0.7);
        const jitter = (Math.random() * 2 - 1) * (this.noise * 0.2);
        return this.currentValue + jitter;
      }

      default: {
        return this.baseline;
      }
    }
  }

  applyScenario(val, scenario) {
    switch (scenario) {
      case 'GRADUAL_RISE': {
        // Accelerate or enforce gradual rise
        return val + (this.tickCount * this.step);
      }

      case 'SPIKE': {
        // Trigger spike on 2nd and 3rd sample
        if (this.tickCount === 2 || this.tickCount === 3) {
          return this.spikeValue;
        }
        return val;
      }

      case 'RECOVERY': {
        // Decay to baseline
        const diff = val - this.baseline;
        return this.baseline + diff * Math.exp(-0.4 * this.tickCount);
      }

      default:
        return val;
    }
  }
}

/**
 * Health Telemetry Generator
 * Generates realistic battery, RSSI, temperature, network, and fault bits.
 */
export class HealthGenerator {
  constructor(config = {}) {
    this.enabled = config !== false;
    this.initialBatteryV = config.batteryV !== undefined ? Number(config.batteryV) : 3.92;
    this.batteryV = this.initialBatteryV;
    this.network = config.network || '4G';
    this.baseRssi = config.rssiDbm !== undefined ? Number(config.rssiDbm) : -78;
    this.baseTempC = config.internalTempC !== undefined ? Number(config.internalTempC) : 31.5;
    this.faultBits = Array.isArray(config.faultBits) ? [...config.faultBits] : [];
    this.tickCount = 0;
  }

  next(scenario = 'NORMAL') {
    if (!this.enabled) return null;
    this.tickCount++;

    // Gradual realistic battery drain (-0.0005V per sample)
    this.batteryV = Math.max(2.8, this.batteryV - 0.0005);
    let currentBattery = Number(this.batteryV.toFixed(2));

    // Realistic RSSI with small fluctuation
    const rssiJitter = Math.floor((Math.random() * 5) - 2); // ±2 dBm
    let currentRssi = this.baseRssi + rssiJitter;

    // Realistic internal temperature
    const tempJitter = (Math.random() * 0.6) - 0.3; // ±0.3 C
    let currentTemp = Number((this.baseTempC + tempJitter).toFixed(1));

    let faultBits = [...this.faultBits];

    // Scenario overrides
    if (scenario === 'LOW_BATTERY') {
      currentBattery = 3.12;
      faultBits.push('LOW_VOLTAGE');
    } else if (scenario === 'POOR_SIGNAL') {
      currentRssi = -108;
    }

    return {
      batteryV: currentBattery,
      rssiDbm: currentRssi,
      network: this.network,
      internalTempC: currentTemp,
      faultBits: Array.from(new Set(faultBits))
    };
  }
}

