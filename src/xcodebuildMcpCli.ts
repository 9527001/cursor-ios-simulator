import { spawn } from 'child_process';

export interface SnapshotUiResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function splitCommand(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;

  for (const ch of raw) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ' ') {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function defaultSnapshotArgs(deviceUdid: string): string[] {
  return [
    '-y',
    'xcodebuildmcp@latest',
    'ui-automation',
    'snapshot-ui',
    '--simulator-id',
    deviceUdid,
    '--output',
    'json',
  ];
}

/** Run `xcodebuildmcp ui-automation snapshot-ui` for a simulator UDID. */
export function runSnapshotUi(deviceUdid: string): Promise<SnapshotUiResult> {
  const override = process.env.XCODEBUILDMCP_CMD?.trim();
  let command: string;
  let args: string[];

  if (override) {
    const expanded = override.includes('{udid}')
      ? override.replaceAll('{udid}', deviceUdid)
      : override;
    const parts = splitCommand(expanded);
    command = parts[0] ?? 'npx';
    args = parts.slice(1);
  } else {
    command = 'npx';
    args = defaultSnapshotArgs(deviceUdid);
  }

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      resolve({
        ok: false,
        error: `xcodebuildmcp snapshot-ui timeout (${DEFAULT_TIMEOUT_MS}ms)`,
      });
    }, DEFAULT_TIMEOUT_MS);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT_BYTES) {
        killed = true;
        proc.kill('SIGTERM');
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!killed) {
        resolve({ ok: false, error: err.message });
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (killed) {
        return;
      }
      if (code !== 0) {
        const line = firstLine(stderr) || firstLine(stdout) || `exit ${code}`;
        resolve({ ok: false, error: line });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

let prefetchPromise: Promise<void> | null = null;

/** Warm npx cache for xcodebuildmcp (non-blocking; annotation-only dependency). */
export function prefetchXcodeBuildMcp(): void {
  if (prefetchPromise || process.env.XCODEBUILDMCP_CMD?.trim()) {
    return;
  }

  prefetchPromise = new Promise((resolve) => {
    const proc = spawn('npx', ['-y', 'xcodebuildmcp@latest', '--version'], {
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve();
    }, 120_000);
    proc.on('error', () => resolve());
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
