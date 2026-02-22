/**
 * mpv-ipc.ts — mpv JSON IPC client over Unix socket.
 *
 * Connects to mpv's IPC server socket, sends JSON commands,
 * and receives property change / event notifications.
 *
 * Protocol: one JSON object per line.
 * Commands: {"command": ["<cmd>", ...args], "request_id": <n>}
 * Events:   {"event": "<name>", ...data}
 * Replies:  {"error": "success", "data": ..., "request_id": <n>}
 */

import * as net from 'net';
import { EventEmitter } from 'events';

export interface MpvProperty {
  property: string;
  value: any;
}

export class MpvIPC extends EventEmitter {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private requestId = 1;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private buffer = '';
  private connected = false;
  private destroyed = false;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) { reject(new Error('MpvIPC destroyed')); return; }

      const sock = new net.Socket();
      this.socket = sock;

      const onConnect = () => {
        this.connected = true;
        sock.removeListener('error', onError);
        resolve();
        this.emit('connected');
      };

      const onError = (err: Error) => {
        sock.removeListener('connect', onConnect);
        reject(err);
      };

      sock.once('connect', onConnect);
      sock.once('error', onError);

      sock.on('data', (data: Buffer) => this.handleData(data));

      sock.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        // Reject all pending requests
        for (const [, prom] of this.pendingRequests) {
          prom.reject(new Error('mpv socket closed'));
        }
        this.pendingRequests.clear();
      });

      sock.on('error', (err: Error) => {
        console.error('[mpv-ipc] socket error:', err.message);
        this.emit('error', err);
      });

      sock.connect(this.socketPath);
    });
  }

  private handleData(data: Buffer) {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.event) {
          this.emit('event', msg);
          this.emit(`event:${msg.event}`, msg);
        } else if (msg.request_id != null) {
          const pending = this.pendingRequests.get(msg.request_id);
          if (pending) {
            this.pendingRequests.delete(msg.request_id);
            if (msg.error === 'success') {
              pending.resolve(msg.data);
            } else {
              pending.reject(new Error(`mpv error: ${msg.error}`));
            }
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  command(...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error('mpv IPC not connected'));
        return;
      }
      const id = this.requestId++;
      this.pendingRequests.set(id, { resolve, reject });

      const msg = JSON.stringify({ command: args, request_id: id }) + '\n';
      this.socket.write(msg, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      // Timeout pending requests after 5s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('mpv IPC timeout'));
        }
      }, 5000);
    });
  }

  async getProperty(name: string): Promise<any> {
    return this.command('get_property', name);
  }

  async setProperty(name: string, value: any): Promise<void> {
    await this.command('set_property', name, value);
  }

  async observeProperty(id: number, name: string): Promise<void> {
    await this.command('observe_property', id, name);
  }

  async play(): Promise<void> {
    await this.setProperty('pause', false);
  }

  async pause(): Promise<void> {
    await this.setProperty('pause', true);
  }

  async togglePause(): Promise<void> {
    await this.command('cycle', 'pause');
  }

  async seek(seconds: number, mode: 'relative' | 'absolute' = 'absolute'): Promise<void> {
    await this.command('seek', seconds, mode);
  }

  async setVolume(vol: number): Promise<void> {
    await this.setProperty('volume', Math.max(0, Math.min(200, vol)));
  }

  async quit(): Promise<void> {
    try {
      await this.command('quit');
    } catch {}
  }

  async loadFile(url: string, audioFile?: string): Promise<void> {
    await this.command('loadfile', url, 'replace');
    if (audioFile) {
      // Wait briefly then set audio-file property
      await new Promise(r => setTimeout(r, 500));
      await this.setProperty('audio-file', audioFile);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  destroy() {
    this.destroyed = true;
    this.connected = false;
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
    this.pendingRequests.clear();
    this.removeAllListeners();
  }
}
