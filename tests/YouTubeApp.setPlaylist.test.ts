import { describe, it, expect, vi } from 'vitest';
import type Client from '../src/lib/app/Client.js';
import type Video from '../src/lib/app/Video.js';
import type { PlaylistPreviousNextVideos } from '../src/lib/app/PlaylistRequestHandler.js';

// YouTubeApp creates its Lounge Sessions with `new`, so replace the class.
const sessions: FakeSession[] = [];

class FakeSession {
  client: Client;
  handlers: Record<string, ((...args: any[]) => void)[]> = {};
  sendMessage = vi.fn((_messages: any, _options?: any) => Promise.resolve());
  registerPairingCode = vi.fn(() => Promise.resolve());
  constructor(options: { client: Client }) {
    this.client = options.client;
    sessions.push(this);
  }
  on(event: string, handler: (...args: any[]) => void) {
    (this.handlers[event] ||= []).push(handler);
    return this;
  }
  begin() {
    return Promise.resolve();
  }
  emitMessages(messages: any) {
    for (const handler of this.handlers.messages || []) handler(messages, this);
  }
}

vi.mock('../src/lib/app/Session.js', () => ({ default: FakeSession }));

const { default: YouTubeApp } = await import('../src/lib/app/YouTubeApp.js');
const { default: Player } = await import('../src/lib/Player.js');
const { default: PlaylistRequestHandler } = await import('../src/lib/app/PlaylistRequestHandler.js');
const { default: Message } = await import('../src/lib/app/Message.js');
const { CLIENTS, PLAYER_STATUSES } = await import('../src/lib/Constants.js');

class RecordingPlayer extends Player {
  doPlay = vi.fn((_video: Video, _position: number) => Promise.resolve(true));
  doGetVolume = vi.fn(() => Promise.resolve({ level: 50, muted: false }));
  protected doPause() { return Promise.resolve(true); }
  protected doResume() { return Promise.resolve(true); }
  protected doStop() { return Promise.resolve(true); }
  protected doSeek() { return Promise.resolve(true); }
  protected doSetVolume() { return Promise.resolve(true); }
  protected doGetPosition() { return Promise.resolve(0); }
  protected doGetDuration() { return Promise.resolve(0); }
}

/** Handler whose answer stays pending until the test resolves it. */
class DeferredHandler extends PlaylistRequestHandler {
  calls = 0;
  #resolvers: ((value: PlaylistPreviousNextVideos) => void)[] = [];
  getPreviousNextVideos(): Promise<PlaylistPreviousNextVideos> {
    this.calls++;
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }
  resolveAll(value: PlaylistPreviousNextVideos = { previous: null, next: null }) {
    this.#resolvers.splice(0).forEach((resolve) => resolve(value));
  }
}

const logger = {
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), setLevel: vi.fn()
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const SENDER = {
  id: 'phone-1',
  name: 'Phone',
  type: 'REMOTE_CONTROL',
  theme: CLIENTS.YTMUSIC.theme,
  capabilities: 'atp,que,mus'
};

async function startConnectedApp() {
  sessions.length = 0;
  const player = new RecordingPlayer();
  const handler = new DeferredHandler();
  const app = new YouTubeApp(player, {
    screenName: 'Test', dataStore: null, logger, playlistRequestHandler: handler
  });
  await app.start();
  const ytm = sessions.find((s) => s.client.theme === CLIENTS.YTMUSIC.theme)!;
  ytm.emitMessages(new Message(1, 'loungeStatus', {
    devices: JSON.stringify([ SENDER ]),
    connectionEventDetails: JSON.stringify({ deviceId: SENDER.id })
  }));
  await flush();
  expect(app.connectedSenders).toHaveLength(1);
  ytm.sendMessage.mockClear();
  return { app, player, handler, ytm };
}

function sentMessages(session: FakeSession): any[] {
  return session.sendMessage.mock.calls.flatMap(([ messages ]) => Array.isArray(messages) ? messages : [ messages ]);
}

const setPlaylist = (AID: number, videoId: string, currentTime = '0') => new Message(AID, 'setPlaylist', {
  listId: 'RDAMVM' + videoId,
  videoIds: `${videoId},bbb`,
  currentIndex: '0',
  videoId,
  currentTime
});

describe('YouTubeApp setPlaylist', () => {
  it('sends LOADING nowPlaying/onStateChange naming the video before the playlist handler resolves', async () => {
    const { player, handler, ytm } = await startConnectedApp();
    const volumeCallsBefore = player.doGetVolume.mock.calls.length;

    ytm.emitMessages(setPlaylist(5, 'aaa', '12'));
    await flush();

    expect(handler.calls).toBe(1);
    const sent = sentMessages(ytm);
    const nowPlaying = sent.find((m) => m.name === 'nowPlaying');
    expect(nowPlaying?.payload).toMatchObject({
      videoId: 'aaa', state: PLAYER_STATUSES.LOADING, currentTime: 12, currentIndex: 0, listId: 'RDAMVMaaa'
    });
    const stateChange = sent.find((m) => m.name === 'onStateChange');
    expect(stateChange?.payload).toMatchObject({ state: PLAYER_STATUSES.LOADING, currentTime: 12 });
    expect(nowPlaying.AID).toBe(5);
    // No player round-trips (e.g. Sonos SOAP) on the early path, and playback has not started yet.
    expect(player.doGetVolume.mock.calls.length).toBe(volumeCallsBefore);
    expect(player.doPlay).not.toHaveBeenCalled();

    handler.resolveAll();
    await flush();
    expect(player.doPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'aaa' }), 12);
  });

  it('does not send an early state when the current video is unchanged', async () => {
    const { handler, ytm } = await startConnectedApp();
    ytm.emitMessages(setPlaylist(5, 'aaa'));
    await flush();
    handler.resolveAll();
    await flush();
    ytm.sendMessage.mockClear();

    ytm.emitMessages(setPlaylist(6, 'aaa'));
    await flush();

    expect(handler.calls).toBe(2);
    expect(sentMessages(ytm).some((m) => m.name === 'nowPlaying')).toBe(false);
    handler.resolveAll();
  });

  it('does not send an early state without connected senders', async () => {
    sessions.length = 0;
    const handler = new DeferredHandler();
    const app = new YouTubeApp(new RecordingPlayer(), {
      screenName: 'Test', dataStore: null, logger, playlistRequestHandler: handler
    });
    await app.start();
    const ytm = sessions.find((s) => s.client.theme === CLIENTS.YTMUSIC.theme)!;
    // Active session is chosen on DIAL launch; senders join later.
    await app.launch(`pairingCode=x&theme=${CLIENTS.YTMUSIC.theme}`).catch(() => undefined);

    ytm.emitMessages(setPlaylist(5, 'aaa'));
    await flush();

    expect(handler.calls).toBe(1);
    expect(sentMessages(ytm).some((m) => m.name === 'nowPlaying')).toBe(false);
    handler.resolveAll();
  });
});
