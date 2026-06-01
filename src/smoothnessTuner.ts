export interface StreamProfile {
  relayFps: number;
  captureMaxWidth: number;
  captureMaxFps: number;
  jpegQuality: number;
}

export interface HostFrameStats {
  sent: number;
  dropped: number;
  avgBytes: number;
}

export interface WebviewPerfStats {
  displayed: number;
  skipped: number;
  avgDecodeMs: number;
}

export interface TunerLimits {
  relayFpsMax: number;
  relayFpsMin: number;
  widthMin: number;
  widthMax: number;
}

const DEFAULT_PROFILE: StreamProfile = {
  relayFps: 18,
  captureMaxWidth: 480,
  captureMaxFps: 24,
  jpegQuality: 0.4,
};

export class SmoothnessTuner {
  private profile: StreamProfile;
  private lowPressureStreak = 0;
  private lastHost: HostFrameStats = { sent: 0, dropped: 0, avgBytes: 0 };
  private lastWeb: WebviewPerfStats | null = null;
  private relayFpsMax: number;

  constructor(
    limits: TunerLimits,
    initial?: Partial<StreamProfile>,
  ) {
    this.relayFpsMax = limits.relayFpsMax;
    this.limits = limits;
    this.profile = {
      ...DEFAULT_PROFILE,
      relayFps: Math.min(DEFAULT_PROFILE.relayFps, limits.relayFpsMax),
      ...initial,
    };
    this.clampProfile();
  }

  private readonly limits: TunerLimits;

  getProfile(): StreamProfile {
    return { ...this.profile };
  }

  setUserMaxFps(maxFps: number): void {
    this.relayFpsMax = maxFps;
    if (this.profile.relayFps > maxFps) {
      this.profile.relayFps = maxFps;
    }
    this.clampProfile();
  }

  ingestHost(stats: HostFrameStats): void {
    this.lastHost = stats;
  }

  ingestWeb(stats: WebviewPerfStats): void {
    this.lastWeb = stats;
  }

  /** Returns updated profile when a change is recommended, else null. */
  evaluate(): { profile: StreamProfile; reason: string } | null {
    const pressure = this.computePressure();
    const prev = JSON.stringify(this.profile);

    if (pressure >= 45) {
      this.lowPressureStreak = 0;
      this.downgrade(pressure);
    } else if (pressure <= 12) {
      this.lowPressureStreak += 1;
      if (this.lowPressureStreak >= 2) {
        this.upgrade();
        this.lowPressureStreak = 0;
      }
    } else {
      this.lowPressureStreak = 0;
    }

    this.clampProfile();
    const next = JSON.stringify(this.profile);
    if (next === prev) {
      return null;
    }

    return {
      profile: { ...this.profile },
      reason: pressure >= 45 ? '负载偏高，降低画质保流畅' : '负载稳定，略微提升画质',
    };
  }

  formatStatusHint(): string {
    const p = this.profile;
    return `${p.relayFps}fps · ${p.captureMaxWidth}px`;
  }

  private computePressure(): number {
    let score = 0;
    const host = this.lastHost;
    const web = this.lastWeb;

    if (host.dropped > 8) {
      score += 25;
    } else if (host.dropped > 3) {
      score += 12;
    }

    if (host.avgBytes > 90_000) {
      score += 20;
    } else if (host.avgBytes > 55_000) {
      score += 10;
    }

    if (web) {
      if (web.avgDecodeMs > 45) {
        score += 25;
      } else if (web.avgDecodeMs > 28) {
        score += 12;
      }
      if (web.skipped > 6) {
        score += 20;
      } else if (web.skipped > 2) {
        score += 10;
      }
    }

    return score;
  }

  private downgrade(pressure: number): void {
    const p = this.profile;
    if (p.relayFps > this.limits.relayFpsMin) {
      p.relayFps -= pressure >= 65 ? 3 : 2;
      return;
    }
    if (p.captureMaxWidth > this.limits.widthMin) {
      p.captureMaxWidth -= pressure >= 65 ? 90 : 60;
      return;
    }
    if (p.captureMaxFps > 12) {
      p.captureMaxFps -= 3;
      return;
    }
    if (p.jpegQuality > 0.28) {
      p.jpegQuality = Math.round((p.jpegQuality - 0.05) * 100) / 100;
    }
  }

  private upgrade(): void {
    const p = this.profile;
    if (p.jpegQuality < 0.52) {
      p.jpegQuality = Math.round((p.jpegQuality + 0.03) * 100) / 100;
      return;
    }
    if (p.captureMaxFps < 30) {
      p.captureMaxFps += 2;
      return;
    }
    if (p.captureMaxWidth < this.limits.widthMax) {
      p.captureMaxWidth += 40;
      return;
    }
    if (p.relayFps < this.relayFpsMax) {
      p.relayFps += 1;
    }
  }

  private clampProfile(): void {
    const p = this.profile;
    p.relayFps = clamp(p.relayFps, this.limits.relayFpsMin, this.relayFpsMax);
    p.captureMaxWidth = clamp(p.captureMaxWidth, this.limits.widthMin, this.limits.widthMax);
    p.captureMaxFps = clamp(p.captureMaxFps, 12, 30);
    p.jpegQuality = clamp(p.jpegQuality, 0.28, 0.55);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function profilesEqual(a: StreamProfile, b: StreamProfile): boolean {
  return (
    a.relayFps === b.relayFps &&
    a.captureMaxWidth === b.captureMaxWidth &&
    a.captureMaxFps === b.captureMaxFps &&
    Math.abs(a.jpegQuality - b.jpegQuality) < 0.001
  );
}

export function captureArgsDiffer(a: StreamProfile, b: StreamProfile): boolean {
  return (
    a.captureMaxWidth !== b.captureMaxWidth ||
    a.captureMaxFps !== b.captureMaxFps ||
    Math.abs(a.jpegQuality - b.jpegQuality) >= 0.001
  );
}
