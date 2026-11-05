import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Simulator State Manager
 * Tracks sequenceNumber, sessionId, and optional local state persistence.
 */
export class SimulatorState {
  constructor(deviceCode, { stateFilePath = null, initialSeq = 1 } = {}) {
    this.deviceCode = deviceCode;
    this.stateFilePath = stateFilePath;
    this.sessionId = crypto.randomBytes(2).toString('hex').toUpperCase(); // e.g. 'A1B2'
    this.sequenceNumber = initialSeq;

    // Load persisted state if exists
    if (this.stateFilePath && fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.deviceCode === this.deviceCode && Number.isInteger(parsed.sequenceNumber)) {
          this.sequenceNumber = parsed.sequenceNumber;
          if (parsed.sessionId) this.sessionId = parsed.sessionId;
        }
      } catch (err) {
        // Silently continue with initial
      }
    }
  }

  /**
   * Generates next sequence number and new unique messageId.
   */
  nextMessage() {
    this.sequenceNumber++;
    this.persist();
    const seqStr = String(this.sequenceNumber).padStart(6, '0');
    const messageId = `${this.deviceCode}-${this.sessionId}-${seqStr}`;
    return {
      sequenceNumber: this.sequenceNumber,
      messageId
    };
  }

  /**
   * Current sequence number and messageId (used during retry).
   */
  currentMessage() {
    const seqStr = String(this.sequenceNumber).padStart(6, '0');
    return {
      sequenceNumber: this.sequenceNumber,
      messageId: `${this.deviceCode}-${this.sessionId}-${seqStr}`
    };
  }

  persist() {
    if (!this.stateFilePath) return;
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFilePath, JSON.stringify({
        deviceCode: this.deviceCode,
        sessionId: this.sessionId,
        sequenceNumber: this.sequenceNumber,
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      // Non-fatal if state save fails
    }
  }
}

