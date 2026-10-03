import type { ClientMsg, ServerMsg } from '../../shared/types';
import { wsUrl } from '../config';

export type NetStatus = 'connecting' | 'online' | 'offline';

/** WebSocket with automatic reconnect. Messages sent while offline are dropped. */
export class Net {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: number | undefined;
  private pingTimer: number | undefined;
  private closed = false;

  constructor(
    private code: string,
    private onMessage: (msg: ServerMsg) => void,
    private onStatus: (s: NetStatus) => void,
    private onOpen: () => void,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.onStatus('connecting');
    const ws = new WebSocket(wsUrl(this.code));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onOpen();
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 25_000);
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus('offline');
      if (this.closed) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg): boolean {
    if (!this.online) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.timer);
    window.clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
