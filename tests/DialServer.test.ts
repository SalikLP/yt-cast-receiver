import { beforeEach, describe, expect, it, vi } from 'vitest';
import dial from '@patrickkfkan/peer-dial';
import DialServer from '../src/lib/dial/DialServer.js';
import type YouTubeApp from '../src/lib/app/YouTubeApp.js';
import type Logger from '../src/lib/utils/Logger.js';

vi.mock('@patrickkfkan/peer-dial', () => ({
  default: {
    Server: vi.fn(function (this: Record<string, unknown>) {
      this.start = vi.fn();
      this.stop = vi.fn();
    })
  }
}));

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), setLevel: vi.fn() } as unknown as Logger;
const app = {} as YouTubeApp;
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('DialServer', () => {
  beforeEach(() => {
    vi.mocked(dial.Server).mockClear();
  });

  it('passes options.uuid to peer-dial so the UDN stays stable across restarts', () => {
    new DialServer(app, { friendlyName: 'Kitchen', uuid: UUID, logger });

    expect(dial.Server).toHaveBeenCalledWith(expect.objectContaining({ uuid: UUID }));
  });

  it('leaves uuid undefined when not given, so peer-dial generates one', () => {
    new DialServer(app, { friendlyName: 'Kitchen', logger });

    expect(vi.mocked(dial.Server).mock.calls[0][0].uuid).toBeUndefined();
  });
});
