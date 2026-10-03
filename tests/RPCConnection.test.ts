import { afterEach, describe, expect, it, vi } from 'vitest';
import RPCConnection from '../src/lib/app/RPCConnection.js';
import BindParams from '../src/lib/app/BindParams.js';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), setLevel: vi.fn() };

function bindParams() {
  const params = new BindParams({ theme: 'm', deviceId: 'dev', screenName: 'Test', screenApp: 'ytcr', brand: 'b', model: 'm' });
  params.loungeIdToken = 'token';
  params.SID = 'SID';
  params.gsessionid = 'gsid';
  return params;
}

/** A long-poll response whose stream ends after `livesMs` (0 = immediately). */
function streamResponse(livesMs: number) {
  return new Response(new ReadableStream({
    start(controller) {
      if (livesMs === 0) {
        controller.close();
      }
      else {
        setTimeout(() => controller.close(), livesMs);
      }
    }
  }));
}

/** Stubs `fetch`; each call takes the next behaviour from `script` (last one repeats). Records call times. */
function stubFetch(script: Array<number | 'error'>) {
  const times: number[] = [];
  const fetch = vi.fn((_url: string, init?: RequestInit) => {
    times.push(Date.now());
    const step = script[Math.min(times.length - 1, script.length - 1)];
    if (step === 'error') {
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    }
    return Promise.resolve(streamResponse(step));
  });
  vi.stubGlobal('fetch', fetch);
  return times;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

describe('RPCConnection reconnect backoff', () => {
  let rpc: RPCConnection | null = null;

  afterEach(() => {
    rpc?.removeAllListeners();
    rpc?.close();
    rpc = null;
    vi.unstubAllGlobals();
  });

  it('backs off exponentially (with cap) when connections keep ending right after being established', async () => {
    const times = stubFetch([ 0 ]);
    rpc = new RPCConnection({ bindParams: bindParams(), logger, backoff: { minHealthyMs: 50, baseMs: 20, maxMs: 80 } });
    const terminate = vi.fn();
    rpc.on('terminate', terminate);

    await rpc.connect();
    await sleep(400);

    // Unbounded reconnecting would be hundreds of requests. Expected delays: 20, 40, 80, 80, 80 ...
    expect(times.length).toBeGreaterThanOrEqual(4);
    expect(times.length).toBeLessThanOrEqual(9);
    const g = gaps(times);
    expect(g[0]).toBeGreaterThanOrEqual(15);
    expect(g[1]).toBeGreaterThanOrEqual(35);
    expect(g[2]).toBeGreaterThanOrEqual(70);
    expect(Math.max(...g)).toBeLessThan(80 + 60); // capped
    expect(terminate).not.toHaveBeenCalled();
  });

  it('reconnects immediately after a healthy connection and resets the backoff', async () => {
    // fast, fast, fast, healthy (lives 100 ms), fast ...
    const times = stubFetch([ 0, 0, 0, 100, 0 ]);
    rpc = new RPCConnection({ bindParams: bindParams(), logger, backoff: { minHealthyMs: 50, baseMs: 20, maxMs: 1000 } });

    await rpc.connect();
    await vi.waitFor(() => expect(times.length).toBeGreaterThanOrEqual(6), { timeout: 2000 });

    const g = gaps(times);
    // g[2]: third fast failure -> 80 ms delay. g[3]: healthy connection lived 100 ms, then immediate reconnect.
    // Without reset the delay after it would be 160 ms.
    expect(g[3]).toBeGreaterThanOrEqual(95);
    expect(g[3]).toBeLessThan(100 + 60);
    // Backoff starts over at base delay.
    expect(g[4]).toBeLessThan(20 + 40);
  });

  it('does not reconnect when closed while waiting to reconnect', async () => {
    const times = stubFetch([ 0 ]);
    rpc = new RPCConnection({ bindParams: bindParams(), logger, backoff: { minHealthyMs: 50, baseMs: 100, maxMs: 100 } });
    const terminate = vi.fn();
    rpc.on('terminate', terminate);

    await rpc.connect();
    await sleep(30);
    rpc.close();
    await sleep(200);

    expect(times).toHaveLength(1);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('waits between retries when the connection request fails', async () => {
    const times = stubFetch([ 'error', 'error', 1000 ]);
    rpc = new RPCConnection({ bindParams: bindParams(), logger, backoff: { minHealthyMs: 50, baseMs: 20, maxMs: 1000 } });

    await rpc.connect();

    expect(times).toHaveLength(3);
    const g = gaps(times);
    expect(g[0]).toBeGreaterThanOrEqual(15);
    expect(g[1]).toBeGreaterThanOrEqual(35);
  });
});
