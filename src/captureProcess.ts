import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { CAPTURE_BIN } from './helperPaths';

export interface StreamStartedInfo {
  type: 'stream-started';
  pixelWidth: number;
  pixelHeight: number;
  pointWidth: number;
  pointHeight: number;
  scale: number;
  deviceUDID: string;
  deviceName: string;
}

export type CaptureStatus =
  | StreamStartedInfo
  | { type: 'no-booted-device' }
  | { type: 'error'; message: string };

export interface CaptureStreamOptions {
  maxWidth?: number;
  maxFps?: number;
  quality?: number;
}

export class CaptureProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private pendingLength: number | null = null;

  start(
    udid?: string,
    captureBin: string = CAPTURE_BIN,
    options: CaptureStreamOptions = {},
  ): void {
    this.stop();
    this.buffer = Buffer.alloc(0);
    this.pendingLength = null;

    const args: string[] = [];
    if (udid) {
      args.push(udid);
    }
    if (options.maxWidth) {
      args.push('--max-width', String(Math.round(options.maxWidth)));
    }
    if (options.maxFps) {
      args.push('--max-fps', String(Math.round(options.maxFps)));
    }
    if (options.quality) {
      args.push('--quality', String(options.quality));
    }

    const proc = spawn(captureBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    if (!proc.stdout || !proc.stderr) {
      this.emit('status', {
        type: 'error',
        message: 'sim-capture stdout/stderr unavailable',
      });
      return;
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      this.consume(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('[sim-capture]')) {
          continue;
        }
        const jsonPart = trimmed.slice('[sim-capture]'.length).trim();
        if (!jsonPart.startsWith('{')) {
          continue;
        }
        try {
          const status = JSON.parse(jsonPart) as CaptureStatus;
          this.emit('status', status);
        } catch {
          // ignore non-JSON stderr lines (fps logs etc.)
        }
      }
    });

    proc.on('exit', (code) => {
      this.emit('exit', code ?? 0);
      this.proc = null;
    });

    proc.on('error', (err) => {
      this.emit('status', { type: 'error', message: err.message });
    });
  }

  stop(): void {
    if (!this.proc) {
      return;
    }
    this.proc.kill('SIGTERM');
    this.proc = null;
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.pendingLength === null) {
        if (this.buffer.length < 4) {
          return;
        }
        this.pendingLength = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.subarray(4);
      }

      const len = this.pendingLength;
      if (this.buffer.length < len) {
        return;
      }

      const jpeg = this.buffer.subarray(0, len);
      this.buffer = this.buffer.subarray(len);
      this.pendingLength = null;
      this.emit('frame', jpeg);
    }
  }
}
