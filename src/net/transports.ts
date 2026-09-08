import type {
  ClientMessage,
  ConnectionState,
  ServerMessage,
  Transport,
} from './types.ts';

/**
 * NullTransport — the default. The game is fully playable offline; this simply
 * drops outgoing messages and never receives any. Keeps the single-player path
 * identical to the multiplayer one.
 */
export class NullTransport implements Transport {
  state: ConnectionState = 'offline';
  connect(): Promise<void> {
    return Promise.resolve();
  }
  send(_msg: ClientMessage): void {
    /* no-op */
  }
  onMessage(_handler: (msg: ServerMessage) => void): void {
    /* no-op */
  }
  onState(_handler: (state: ConnectionState) => void): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
}

/**
 * WebSocketTransport — a JSON-over-WebSocket implementation ready to talk to an
 * authoritative server. Not used until you call `NetworkManager.connect(url)`,
 * but fully wired so going online is a one-line change.
 */
export class WebSocketTransport implements Transport {
  state: ConnectionState = 'offline';
  private ws: WebSocket | null = null;
  private readonly url: string;
  private messageHandler: ((msg: ServerMessage) => void) | null = null;
  private stateHandler: ((state: ConnectionState) => void) | null = null;
  private reconnectAttempts = 0;

  constructor(url: string) {
    this.url = url;
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.stateHandler?.(s);
  }

  connect(): Promise<void> {
    this.setState('connecting');
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        this.setState('error');
        reject(err instanceof Error ? err : new Error('WebSocket init failed'));
        return;
      }

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setState('online');
        resolve();
      };
      this.ws.onmessage = (ev) => {
        try {
          this.messageHandler?.(JSON.parse(ev.data as string) as ServerMessage);
        } catch {
          /* ignore malformed frames */
        }
      };
      this.ws.onerror = () => this.setState('error');
      this.ws.onclose = () => {
        if (this.state === 'online') this.scheduleReconnect();
        else this.setState('offline');
      };
    });
  }

  private scheduleReconnect(): void {
    this.setState('connecting');
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10000);
    this.reconnectAttempts++;
    setTimeout(() => void this.connect().catch(() => this.setState('error')), delay);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  onState(handler: (state: ConnectionState) => void): void {
    this.stateHandler = handler;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.setState('offline');
  }
}
