import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Client from '../src/lib/app/Client.js';

// YouTubeApp creates its Lounge Sessions with `new`, so replace the class.
const sessions: FakeSession[] = [];

class FakeSession {
  client: Client;
  registerPairingCode = vi.fn(() => Promise.resolve());
  sendMessage = vi.fn(() => Promise.resolve());
  constructor(options: { client: Client }) {
    this.client = options.client;
    sessions.push(this);
  }
  on() {
    return this;
  }
}

vi.mock('../src/lib/app/Session.js', () => ({ default: FakeSession }));

const { default: YouTubeApp } = await import('../src/lib/app/YouTubeApp.js');
const { default: Player } = await import('../src/lib/Player.js');
const { CLIENTS } = await import('../src/lib/Constants.js');

class NoopPlayer extends Player {
  protected doPlay() { return Promise.resolve(true); }
  protected doPause() { return Promise.resolve(true); }
  protected doResume() { return Promise.resolve(true); }
  protected doStop() { return Promise.resolve(true); }
  protected doSeek() { return Promise.resolve(true); }
  protected doSetVolume() { return Promise.resolve(true); }
  protected doGetVolume() { return Promise.resolve({ level: 50, muted: false }); }
  protected doGetPosition() { return Promise.resolve(0); }
  protected doGetDuration() { return Promise.resolve(0); }
}

const logger = {
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), setLevel: vi.fn()
};

function createApp() {
  sessions.length = 0;
  const app = new YouTubeApp(new NoopPlayer(), { screenName: 'Test', dataStore: null, logger });
  const sessionFor = (theme: string) => {
    const session = sessions.find((s) => s.client.theme === theme);
    if (!session) throw new Error(`No session for theme ${theme}`);
    return session;
  };
  return { app, yt: sessionFor(CLIENTS.YT.theme), ytm: sessionFor(CLIENTS.YTMUSIC.theme) };
}

describe('YouTubeApp.launch() Lounge Session routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { launchData: 'pairingCode=123&theme=cl&topic=music', expected: 'YTMUSIC' },
    { launchData: 'pairingCode=123&topic=music', expected: 'YTMUSIC' },
    { launchData: 'pairingCode=123&theme=m', expected: 'YTMUSIC' },
    { launchData: 'pairingCode=123&theme=m&topic=music', expected: 'YTMUSIC' },
    { launchData: 'pairingCode=123&theme=cl', expected: 'YT' },
    { launchData: 'pairingCode=123&theme=cl&topic=other', expected: 'YT' }
  ])('$launchData → $expected Session', async ({ launchData, expected }) => {
    const { app, yt, ytm } = createApp();
    const [ chosen, other ] = expected === 'YTMUSIC' ? [ ytm, yt ] : [ yt, ytm ];

    await app.launch(launchData);

    expect(chosen.registerPairingCode).toHaveBeenCalledWith('123');
    expect(other.registerPairingCode).not.toHaveBeenCalled();
  });

  it('rejects an unknown theme without topic=music', async () => {
    const { app, yt, ytm } = createApp();

    await expect(app.launch('pairingCode=123&theme=xx')).rejects.toThrow('Failed to launch YouTubeApp');

    expect(yt.registerPairingCode).not.toHaveBeenCalled();
    expect(ytm.registerPairingCode).not.toHaveBeenCalled();
  });
});
