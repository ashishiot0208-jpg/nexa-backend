/**
 * HTTP Telemetry Transport with Bounded Network Retries
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class HttpTransport {
  constructor({
    targetUrl = 'http://127.0.0.1:3000/api/v1/telemetry/ingest',
    apiKey = null,
    deviceKeyHeader = process.env.DEVICE_KEY_HEADER || 'x-device-key',
    maxRetries = 3,
    retryDelayMs = 1000,
    fetchFn = globalThis.fetch
  } = {}) {
    this.targetUrl = targetUrl;
    this.apiKey = apiKey;
    this.deviceKeyHeader = (deviceKeyHeader || 'x-device-key').toLowerCase();
    this.maxRetries = Math.max(0, maxRetries);
    this.retryDelayMs = Math.max(100, retryDelayMs);
    this.fetch = fetchFn;
  }

  async send(packet, { onRetry = () => {} } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'NexaIQ-Field-Simulator/1.0'
    };

    if (this.apiKey) {
      headers[this.deviceKeyHeader] = this.apiKey;
    }

    const bodyStr = JSON.stringify(packet);
    let attempts = 0;
    let lastError = null;

    while (attempts <= this.maxRetries) {
      attempts++;
      try {
        const res = await this.fetch(this.targetUrl, {
          method: 'POST',
          headers,
          body: bodyStr
        });

        const status = res.status;
        let responseData = null;
        try {
          responseData = await res.json();
        } catch {
          responseData = await res.text();
        }

        // If HTTP 2xx, transmission succeeded
        if (res.ok) {
          return {
            success: true,
            status,
            data: responseData,
            attempts
          };
        }

        // If 4xx client error (e.g. 400 Invalid Payload, 404 Device Not Found),
        // do not retry as resending identical payload will fail identically.
        if (status >= 400 && status < 500) {
          return {
            success: false,
            status,
            data: responseData,
            attempts,
            error: new Error(`HTTP ${status}: ${typeof responseData === 'object' ? JSON.stringify(responseData) : responseData}`)
          };
        }

        // If 5xx server error, treat as transient failure and retry if attempts remain
        lastError = new Error(`Server returned HTTP ${status}: ${typeof responseData === 'object' ? JSON.stringify(responseData) : responseData}`);

      } catch (networkErr) {
        lastError = networkErr;
      }

      // If attempts remain, wait with backoff and retry SAME packet
      if (attempts <= this.maxRetries) {
        const backoffMs = this.retryDelayMs * Math.pow(1.5, attempts - 1);
        onRetry({
          packet,
          attempt: attempts,
          maxRetries: this.maxRetries,
          error: lastError,
          backoffMs
        });
        await sleep(backoffMs);
      }
    }

    return {
      success: false,
      status: null,
      data: null,
      attempts,
      error: lastError || new Error('Max retries exceeded')
    };
  }
}

