import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SimDevice {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown' | string;
  runtime: string;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
}

const DEVICE_PREFERENCES = [
  'iPhone 16 Pro Max',
  'iPhone 16 Pro',
  'iPhone 15 Pro Max',
  'iPhone 15 Pro',
];

let deviceListCache: { at: number; devices: SimDevice[] } | null = null;
const DEVICE_LIST_CACHE_MS = 2000;

export function invalidateDeviceListCache(): void {
  deviceListCache = null;
}

export async function listAllDevices(force = false): Promise<SimDevice[]> {
  const now = Date.now();
  if (
    !force &&
    deviceListCache &&
    now - deviceListCache.at < DEVICE_LIST_CACHE_MS
  ) {
    return deviceListCache.devices;
  }

  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j']);
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, SimctlDevice[]>;
    };

    const devices: SimDevice[] = [];
    for (const [runtimeId, runtimeDevices] of Object.entries(parsed.devices)) {
      const runtime = simplifyRuntime(runtimeId);
      for (const d of runtimeDevices) {
        if (!d.udid || !d.name) {
          continue;
        }
        devices.push({
          udid: d.udid,
          name: d.name,
          state: d.state,
          runtime,
        });
      }
    }
    const sorted = devices.sort((a, b) => a.name.localeCompare(b.name));
    deviceListCache = { at: now, devices: sorted };
    return sorted;
  } catch {
    return deviceListCache?.devices ?? [];
  }
}

export async function getDeviceSnapshot(force = false): Promise<{
  all: SimDevice[];
  booted: SimDevice[];
  picker: SimDevice[];
}> {
  const all = await listAllDevices(force);
  const booted = all.filter((d) => d.state === 'Booted');
  const iphones = all.filter((d) => d.name.includes('iPhone'));
  const picker = iphones.sort((a, b) => {
    const rank = (name: string) => {
      const idx = DEVICE_PREFERENCES.indexOf(name);
      return idx === -1 ? DEVICE_PREFERENCES.length + 1 : idx;
    };
    const ra = rank(a.name);
    const rb = rank(b.name);
    if (ra !== rb) {
      return ra - rb;
    }
    if (a.state === 'Booted' && b.state !== 'Booted') {
      return -1;
    }
    if (b.state === 'Booted' && a.state !== 'Booted') {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return { all, booted, picker };
}

export async function listBootedDevices(): Promise<SimDevice[]> {
  const all = await listAllDevices();
  return all.filter((d) => d.state === 'Booted');
}

/** iPhone simulators for the device picker, preferred models first. */
export async function listPickerDevices(): Promise<SimDevice[]> {
  return (await getDeviceSnapshot()).picker;
}

export async function bootDevice(udid: string): Promise<void> {
  await execFileAsync('xcrun', ['simctl', 'boot', udid]);
  invalidateDeviceListCache();
}

export async function openSimulatorApp(): Promise<void> {
  await execFileAsync('open', ['-a', 'Simulator']);
}

/** Boot without opening Simulator.app (headless mirror). */
export async function bootDeviceHeadless(udid: string): Promise<void> {
  const devices = await listAllDevices();
  const target = devices.find((d) => d.udid === udid);
  if (!target) {
    throw new Error(`Device not found: ${udid}`);
  }
  if (target.state !== 'Booted') {
    await dismissSimulatorAppWindow();
    await bootDevice(udid);
    const ready = await waitForBoot(udid, 90_000);
    if (!ready) {
      throw new Error(`Timed out booting ${target.name}`);
    }
  }
}

/** @deprecated Prefer bootDeviceHeadless for mirror-only workflow. */
export async function bootAndPrepare(udid: string): Promise<void> {
  await bootDeviceHeadless(udid);
  await openSimulatorApp();
}

export async function dismissSimulatorAppWindow(): Promise<void> {
  try {
    await execFileAsync('/usr/bin/killall', ['-q', 'Simulator']);
  } catch {
    // killall exits 1 when Simulator is not running — that's fine.
  }
}

const AUTO_BOOT_PATTERNS = [/iPhone 16/, /iPhone 15/, /iPhone 14/, /iPhone/];

/** Boot a sensible default iPhone when nothing is running. */
export async function ensureDefaultBooted(): Promise<SimDevice | null> {
  const booted = await listBootedDevices();
  if (booted.length > 0) {
    return pickPreferredBootedDevice();
  }

  const iphones = (await listAllDevices()).filter((d) => d.name.includes('iPhone'));
  let pick: SimDevice | null = null;
  for (const pattern of AUTO_BOOT_PATTERNS) {
    const match = iphones.find((d) => pattern.test(d.name));
    if (match) {
      pick = match;
      break;
    }
  }
  if (!pick) {
    return null;
  }

  await bootDeviceHeadless(pick.udid);
  return { ...pick, state: 'Booted' };
}

export async function waitForBoot(udid: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const devices = await listAllDevices();
    const device = devices.find((d) => d.udid === udid);
    if (device?.state === 'Booted') {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

function simplifyRuntime(runtimeId: string): string {
  const match = runtimeId.match(/iOS[- ]([\d-]+)/i);
  if (match) {
    return `iOS ${match[1].replace(/-/g, '.')}`;
  }
  return runtimeId;
}

export async function getFrontSimulatorDeviceName(): Promise<string | null> {
  try {
    const script = `
      tell application "System Events"
        if exists (process "Simulator") then
          tell process "Simulator"
            if (count of windows) > 0 then return name of front window
          end tell
        end if
      end tell
    `;
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    const title = stdout.trim();
    if (!title) {
      return null;
    }
    return title.replace(/ – iOS .*$/u, '').replace(/ - iOS .*$/, '');
  } catch {
    return null;
  }
}

export async function pickPreferredBootedDevice(
  options: { quick?: boolean } = {},
): Promise<SimDevice | null> {
  const booted = await listBootedDevices();
  if (booted.length === 0) {
    return null;
  }

  if (options.quick) {
    for (const pref of DEVICE_PREFERENCES) {
      const match = booted.find((d) => d.name === pref);
      if (match) {
        return match;
      }
    }
    return booted[0] ?? null;
  }

  const frontName = await getFrontSimulatorDeviceName();

  for (const pref of DEVICE_PREFERENCES) {
    const match = booted.find((d) => d.name === pref && d.name !== frontName);
    if (match) {
      return match;
    }
  }

  const nonFront = booted.find((d) => d.name !== frontName);
  return nonFront ?? booted[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
