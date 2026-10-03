import EventEmitter from 'events';
import LineByLineReader from 'line-by-line';
import { Readable } from 'stream';
import Message from './Message.js';
import type BindParams from './BindParams.js';
import { AbortError, BadResponseError, ConnectionError } from '../utils/Errors.js';
import type Logger from '../utils/Logger.js';
import { URLS } from '../Constants.js';

const MAX_RETRIES = 3;

/**
 * @internal
 *
 * Reconnect backoff settings for {@link RPCConnection}.
 */
export interface RPCBackoffOptions {
  /** A connection that ends sooner than this after being established counts as a failure. */
  minHealthyMs: number;
  /** Delay before the first reconnect / retry after a failure. Doubles with each consecutive failure. */
  baseMs: number;
  /** Maximum delay. */
  maxMs: number;
}

const DEFAULT_BACKOFF: RPCBackoffOptions = {
  minHealthyMs: 1000,
  baseMs: 500,
  maxMs: 30000
};

/**
 * @internal
 *
 * Connects to YouTube 'bind' URL and listens for messages.
 * Incoming messages are parsed into {@link Message} objects and returned through events.
 *
 * When the underlying connection is ended by remote, which is inevitable under normal circumstance,
 * the `RPCConnection` instance will automatically reconnect.
 */
export default class RPCConnection extends EventEmitter {

  #bindParams: BindParams;
  #logger: Logger;
  #status: 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected';
  #abortController: AbortController | null;
  #reader: LineByLineReader | null;
  #backoff: RPCBackoffOptions;
  #connectedAt = 0;
  #fastFailures = 0;
  #wait: { timer: NodeJS.Timeout, resolve: (completed: boolean) => void } | null = null;

  constructor(options: { bindParams: BindParams, logger: Logger, backoff?: Partial<RPCBackoffOptions> }) {
    super();
    this.#bindParams = options.bindParams;
    this.#logger = options.logger;
    this.#status = 'disconnected';
    this.#abortController = null;
    this.#reader = null;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  }

  async connect() {
    if (this.#status === 'disconnected') {
      return this.#doConnect();
    }
  }

  async #doConnect(isReconnect = false, retry = 0): Promise<void> {
    this.#status = isReconnect ? 'reconnecting' : 'connecting';
    const url = `${URLS.BIND}?${this.#bindParams.toQueryString('rpc')}`;
    this.#logger.debug(`[yt-cast-receiver] Connecting to RPC URL: ${url}`);

    this.#abortController = new AbortController();
    let response;
    try {
      response = await fetch(url, { signal: this.#abortController.signal });
    }
    catch (error: any) {
      if (error.name === 'AbortError') {
        this.#logger.debug('[yt-cast-receiver] RPC connection request aborted.');
        this.#status = 'disconnected';
        throw new AbortError('RPC connection request aborted', url);
      }

      this.#logger.error('[yt-cast-receiver] RPC connection error:', error);
      retry++;
      if (retry <= MAX_RETRIES) {
        const delay = this.#getBackoffDelay(retry);
        this.#logger.error(`[yt-cast-receiver] Retrying ${retry} / ${MAX_RETRIES} in ${delay}ms`);
        this.#abortController = null;
        if (!(await this.#sleep(delay))) {
          this.#logger.debug('[yt-cast-receiver] RPC connection retry aborted.');
          throw new AbortError('RPC connection request aborted', url);
        }
        return await this.#doConnect(isReconnect, retry);
      }

      this.#status = 'disconnected';
      this.#logger.error('[yt-cast-receiver] Max retries reached. Giving up...');
      throw new ConnectionError('RPC connection error', url, error);
    }
    finally {
      this.#abortController = null;
    }

    if (response.ok && response.body) {
      this.#logger.debug('[yt-cast-receiver] RPC connection established.');
      this.#status = 'connected';
      this.#connectedAt = Date.now();

      const readable = Readable.fromWeb(response.body as any);
      const reader = this.#reader = new LineByLineReader(readable, {
        encoding: 'utf8',
        skipEmptyLines: true
      });
      // Both `reader` and `readable` signal the end of this connection; only handle it once,
      // and never for a connection that has already been replaced.
      const handleDisconnect = () => {
        if (this.#reader === reader) {
          this.#handleDisconnect();
        }
      };

      reader.on('line', (line) => {
        if (this.#status === 'connected') {
          const messages = Message.parseIncoming(line);
          if (messages.length > 0) {
            this.emit('messages', messages);
          }
        }
      });

      reader.on('error', (error) => {
        this.#logger.error('[yt-cast-receiver] RPC connection reader error:', error);
        // Force disconnect
        readable.destroy();
        handleDisconnect();
      });

      reader.on('end', handleDisconnect);
      readable.on('end', handleDisconnect);

      return;
    }

    this.#status = 'disconnected';
    throw new BadResponseError('RPC connection request returned bad response', url, response);
  }

  #handleDisconnect() {
    if (this.#status === 'disconnected') {
      // Already handled
      return;
    }

    const prevStatus = this.#status;
    this.#status = 'disconnected';

    if (this.#reader) {
      this.#reader.removeAllListeners();
      this.#reader = null;
    }

    if (prevStatus === 'connected') {
      // Disconnected by remote end or reader error - reconnect.
      // Normal long-polls end after minutes: reconnect at once. A connection that ends right
      // after being established (e.g. evicted by another connection using the same SID) must
      // not turn into a tight reconnect loop: back off exponentially.
      const lived = Date.now() - this.#connectedAt;
      if (lived < this.#backoff.minHealthyMs) {
        this.#fastFailures++;
      }
      else {
        this.#fastFailures = 0;
      }
      const delay = this.#getBackoffDelay(this.#fastFailures);
      this.#status = 'reconnecting';
      if (delay > 0) {
        this.#logger.warn(`[yt-cast-receiver] RPC connection ended after ${lived}ms. Reconnecting in ${delay}ms...`);
      }
      else {
        this.#logger.debug('[yt-cast-receiver] RPC connection disconnected. Reconnecting...');
      }
      void (async () => {
        try {
          if (!(await this.#sleep(delay)) || this.#status !== 'reconnecting') {
            return; // Closed while waiting
          }
          await this.#doConnect(true);
        }
        catch (error) {
          this.emit('terminate', error);
        }
      })();
    }
    else {
      this.#logger.debug('[yt-cast-receiver] RPC connection closed.');
    }
  }

  close() {
    if (this.#status === 'connected' || this.#status === 'connecting' || this.#status === 'reconnecting') {
      this.#logger.debug('[yt-cast-receiver] Closing RPC connection...');
      this.#status = 'disconnecting';
      if (this.#wait) {
        // Waiting to reconnect / retry - nothing in flight.
        clearTimeout(this.#wait.timer);
        this.#wait.resolve(false);
        this.#wait = null;
        this.#status = 'disconnected';
      }
      if (this.#abortController) {
        this.#abortController.abort();
      }
      if (this.#reader) {
        this.#reader.close();
      }
    }
  }

  /** @returns 0 for no failures, else `baseMs * 2^(failures - 1)`, capped at `maxMs`. */
  #getBackoffDelay(failures: number) {
    if (failures <= 0) {
      return 0;
    }
    return Math.min(this.#backoff.baseMs * 2 ** (failures - 1), this.#backoff.maxMs);
  }

  /** @returns `true` once `ms` has elapsed, `false` if `close()` was called meanwhile. */
  #sleep(ms: number): Promise<boolean> {
    if (ms <= 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.#wait = {
        timer: setTimeout(() => {
          this.#wait = null;
          resolve(true);
        }, ms),
        resolve
      };
    });
  }

  /**
   * @event
   * Emitted when an irrecoverable error has occurred and the connection is forced to terminate.
   * @param listener.error - the error that triggered the event.
   */
  on(event: 'terminate', listener: (error: Error) => void): this;
  /**
   * @event
   * Emitted when messages received.
   * @param listener.messages: Array of `Message` objects.
   */
  on(event: 'messages', listener: (messages: Message[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }
}
