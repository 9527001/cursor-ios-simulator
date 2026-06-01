import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function captureSimulatorScreenshot(
  udid: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(os.homedir(), 'Desktop', `ios-sim-${stamp}.png`);

  try {
    await execFileAsync('xcrun', ['simctl', 'io', udid, 'screenshot', dest]);
    return { ok: true, path: dest };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
