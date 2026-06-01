import type { Webview } from 'vscode';

export interface FrameRelayStats {
  sent: number;
  dropped: number;
  avgBytes: number;
}

/** Limits mirror FPS and coalesces bursts before base64 postMessage. */
export class FrameRelay {
  private pending: Buffer | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private maxFps: number;
  private sent = 0;
  private dropped = 0;
  private bytesTotal = 0;

  constructor(
    maxFps: number,
    private readonly onFrame: (jpeg: Buffer) => void,
  ) {
    this.maxFps = Math.max(1, maxFps);
  }

  setMaxFps(maxFps: number): void {
    this.maxFps = Math.max(1, maxFps);
  }

  getMaxFps(): number {
    return this.maxFps;
  }

  push(jpeg: Buffer, webview: Webview | undefined, enabled: boolean): void {
    if (!enabled || !webview) {
      return;
    }

    this.pending = jpeg;
    const intervalMs = 1000 / this.maxFps;
    const now = Date.now();
    const elapsed = now - this.lastSentAt;

    if (elapsed >= intervalMs) {
      this.flush();
      return;
    }

    if (this.flushTimer) {
      this.dropped += 1;
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, intervalMs - elapsed);
  }

  consumeStats(): FrameRelayStats {
    const stats: FrameRelayStats = {
      sent: this.sent,
      dropped: this.dropped,
      avgBytes: this.sent > 0 ? Math.round(this.bytesTotal / this.sent) : 0,
    };
    this.sent = 0;
    this.dropped = 0;
    this.bytesTotal = 0;
    return stats;
  }

  reset(): void {
    this.pending = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastSentAt = 0;
    this.sent = 0;
    this.dropped = 0;
    this.bytesTotal = 0;
  }

  private flush(): void {
    if (!this.pending) {
      return;
    }
    const frame = this.pending;
    this.pending = null;
    this.lastSentAt = Date.now();
    this.sent += 1;
    this.bytesTotal += frame.length;
    this.onFrame(frame);
  }
}
