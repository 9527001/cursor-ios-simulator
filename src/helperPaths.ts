import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const CACHE_DIR = path.join(
  os.homedir(),
  'Library',
  'Caches',
  'co.cursor.ios-simulator',
);

export const CAPTURE_BIN = path.join(CACHE_DIR, 'sim-capture');
export const INPUT_BIN = path.join(CACHE_DIR, 'sim-input');

export interface HelperBinaries {
  capture: string;
  input: string;
}

function binariesExist(capture: string, input: string): boolean {
  return fs.existsSync(capture) && fs.existsSync(input);
}

export function bundledHelperDir(extensionRoot: string): string {
  return path.join(extensionRoot, 'bin');
}

/** Fast lookup only — never compiles (safe on startup hot path). */
export function findHelperBinariesSync(extensionRoot: string): HelperBinaries | null {
  const bundledCapture = path.join(bundledHelperDir(extensionRoot), 'sim-capture');
  const bundledInput = path.join(bundledHelperDir(extensionRoot), 'sim-input');
  if (binariesExist(bundledCapture, bundledInput)) {
    return { capture: bundledCapture, input: bundledInput };
  }
  if (binariesExist(CAPTURE_BIN, INPUT_BIN)) {
    return { capture: CAPTURE_BIN, input: INPUT_BIN };
  }
  return null;
}

export function compileHelpers(extensionRoot: string, outDir?: string): string {
  const script = path.join(extensionRoot, 'scripts', 'compile-helpers.sh');
  const target = outDir ?? CACHE_DIR;
  execFileSync('bash', [script, target], { stdio: 'inherit' });
  return target;
}

async function compileHelpersAsync(
  extensionRoot: string,
  outDir: string,
): Promise<void> {
  const script = path.join(extensionRoot, 'scripts', 'compile-helpers.sh');
  await execFileAsync('bash', [script, outDir]);
}

/** Compile helpers in background when bundled/cache binaries are missing. */
export async function ensureHelperBinariesAsync(
  extensionRoot: string,
): Promise<HelperBinaries> {
  const existing = findHelperBinariesSync(extensionRoot);
  if (existing) {
    return existing;
  }

  if (process.platform !== 'darwin') {
    throw new Error('Native helpers 需要 macOS。');
  }

  const bundledDir = bundledHelperDir(extensionRoot);
  const bundledCapture = path.join(bundledDir, 'sim-capture');
  const bundledInput = path.join(bundledDir, 'sim-input');

  try {
    await compileHelpersAsync(extensionRoot, bundledDir);
    if (binariesExist(bundledCapture, bundledInput)) {
      return { capture: bundledCapture, input: bundledInput };
    }
  } catch {
    // Fall through to cache compile.
  }

  await compileHelpersAsync(extensionRoot, CACHE_DIR);
  if (!binariesExist(CAPTURE_BIN, INPUT_BIN)) {
    throw new Error('Native helpers 未就绪。请运行: npm run setup');
  }
  return { capture: CAPTURE_BIN, input: INPUT_BIN };
}

/** Resolve helpers; compiles synchronously if missing (avoid on startup). */
export function ensureHelperBinaries(extensionRoot: string): HelperBinaries {
  const existing = findHelperBinariesSync(extensionRoot);
  if (existing) {
    return existing;
  }

  if (process.platform === 'darwin') {
    const bundledDir = bundledHelperDir(extensionRoot);
    const bundledCapture = path.join(bundledDir, 'sim-capture');
    const bundledInput = path.join(bundledDir, 'sim-input');
    try {
      compileHelpers(extensionRoot, bundledDir);
      if (binariesExist(bundledCapture, bundledInput)) {
        return { capture: bundledCapture, input: bundledInput };
      }
    } catch {
      // Fall through.
    }
    compileHelpers(extensionRoot, CACHE_DIR);
  }

  if (!binariesExist(CAPTURE_BIN, INPUT_BIN)) {
    throw new Error('Native helpers 未就绪。请在 macOS 上运行: npm run setup');
  }
  return { capture: CAPTURE_BIN, input: INPUT_BIN };
}

/** @deprecated Use ensureHelperBinariesAsync() or findHelperBinariesSync(). */
export function ensureHelpers(extensionRoot: string): void {
  ensureHelperBinaries(extensionRoot);
}

export function helpersReady(): boolean {
  return binariesExist(CAPTURE_BIN, INPUT_BIN);
}
