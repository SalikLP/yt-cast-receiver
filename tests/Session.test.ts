import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fake RPCConnection: records construction / close order, never touches the network.
const rpcLog: string[] = [];
const rpcs: FakeRPC[] = [];

class FakeRPC extends EventEmitter {
  index: number;
  closed = false;
  constructor() {
    super();
    this.index = rpcs.length;
    rpcs.push(this);
    rpcLog.push(`new rpc${this.index}`);
  }
  connect() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    rpcLog.push(`close rpc${this.index}`);
  }
}

vi.mock('../src/lib/app/RPCConnection.js', () => ({ default: FakeRPC }));

const { default: Session } = await import('../src/lib/app/Session.js');
const { default: Message } = await import('../src/lib/app/Message.js');
const { CLIENTS } = await import('../src/lib/Constants.js');
const { default: BindParams } = await import('../src/lib/app/BindParams.js');

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), setLevel: vi.fn() };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { promise, resolve };
}

/** Fake lounge API. Counts calls per endpoint; lets a test hold `get_lounge_token_batch`. */
function fakeLounge() {
  const calls = { screenId: 0, loungeToken: 0, initSession: 0, send: 0 };
  let loungeTokenGate: Promise<void> | null = null;
  let sid = 0;
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('generate_screen_id')) {
      calls.screenId++;
      return new Response('screen1');
    }
    if (url.includes('get_lounge_token_batch')) {
      calls.loungeToken++;
      if (loungeTokenGate) {
        await loungeTokenGate;
      }
      return Response.json({ screens: [ { screenId: 'screen1', loungeToken: 'token', refreshIntervalInMillis: 1e9, expiration: 0, loungeTokenLifespanMs: 0 } ] });
    }
    if (url.includes('/bind?')) {
      if (url.includes('SID=')) {
        calls.send++;
        return new Response('');
      }
      calls.initSession++;
      sid++;
      return new Response(`[[0,["c","SID${sid}","",8]],[1,["S","gsid${sid}"]]]`);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return {
    calls,
    fetch,
    holdLoungeToken(gate: Promise<void>) {
      loungeTokenGate = gate;
    }
  };
}

function newSession() {
  return new Session({
    client: CLIENTS.YTMUSIC,
    screenName: 'Test',
    screenApp: 'ytcr',
    brand: 'brand',
    model: 'model',
    dataStore: null,
    logger
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Session lounge token refresh', () => {
  let lounge: ReturnType<typeof fakeLounge>;

  beforeEach(() => {
    rpcLog.length = 0;
    rpcs.length = 0;
    lounge = fakeLounge();
    vi.stubGlobal('fetch', lounge.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs a single refresh when the RPC terminates and a send fails at the same time', async () => {
    const session = newSession();
    await session.begin();
    expect(rpcs).toHaveLength(1);
    expect(lounge.calls.initSession).toBe(1);

    const gate = deferred();
    lounge.holdLoungeToken(gate.promise);

    // Make the next send task throw -> SendMessageTask.onError -> refresh.
    const toQueryString = BindParams.prototype.toQueryString;
    let failNextSend = true;
    vi.spyOn(BindParams.prototype, 'toQueryString').mockImplementation(function (this: InstanceType<typeof BindParams>, type, AID) {
      if (type === 'sendMessage' && failNextSend) {
        failNextSend = false;
        throw new Error('send failed');
      }
      return toQueryString.call(this, type, AID);
    });

    // Send task starts and fails (its onError runs on a later microtask) ...
    session.sendMessage(new Message(null, 'nowPlaying', {})).catch(() => undefined);
    // ... while the RPC connection gives up -> refresh #1 starts and waits for the lounge token.
    rpcs[0].emit('terminate', new Error('rpc gave up'));
    // onError -> refresh #2, which must join #1.
    await tick();
    await tick();

    gate.resolve();

    await vi.waitFor(() => expect(lounge.calls.send).toBe(1)); // task retried after refresh
    await tick();

    expect(lounge.calls.loungeToken).toBe(2);
    expect(lounge.calls.initSession).toBe(2);
    expect(rpcs).toHaveLength(2);
    expect(rpcs[0].closed).toBe(true);
    expect(rpcs[1].closed).toBe(false);
    expect(lounge.calls.send).toBe(1);
  });

  it('closes the old RPC connection before creating the new one', async () => {
    const session = newSession();
    await session.begin();

    rpcs[0].emit('terminate', new Error('rpc gave up'));
    await vi.waitFor(() => expect(rpcs).toHaveLength(2));

    expect(rpcLog).toEqual([ 'new rpc0', 'close rpc0', 'new rpc1' ]);
    expect(rpcs[0].listenerCount('terminate')).toBe(0);
    expect(rpcs[0].listenerCount('messages')).toBe(0);
  });

  it('allows another refresh once the previous one has finished', async () => {
    const session = newSession();
    await session.begin();

    rpcs[0].emit('terminate', new Error('first'));
    await vi.waitFor(() => expect(rpcs).toHaveLength(2));
    await tick();

    rpcs[1].emit('terminate', new Error('second'));
    await vi.waitFor(() => expect(rpcs).toHaveLength(3));

    expect(lounge.calls.initSession).toBe(3);
    expect(rpcs[1].closed).toBe(true);
  });

  it('does not leave a new RPC connection open when the session ends during a refresh', async () => {
    const session = newSession();
    await session.begin();

    const gate = deferred();
    lounge.holdLoungeToken(gate.promise);
    rpcs[0].emit('terminate', new Error('rpc gave up'));
    await vi.waitFor(() => expect(lounge.calls.loungeToken).toBe(2));

    const ended = session.end();
    gate.resolve();
    await ended;
    await tick();

    expect(rpcs.every((rpc) => rpc.closed)).toBe(true);
  });
});
