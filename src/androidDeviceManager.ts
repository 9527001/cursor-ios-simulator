import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AndroidDevice {
  /** adb 序列号，如 emulator-5554 或真机序列。 */
  serial: string;
  /** 友好名称（ro.product.model，未取到时回退序列号）。 */
  model: string;
  /** adb 连接状态：device / offline / unauthorized 等。 */
  state: string;
  /** 是否为模拟器（serial 以 emulator- 开头）。 */
  isEmulator: boolean;
}

let cachedAdbPath: string | null = null;

/**
 * 跨平台解析 adb 可执行路径：优先 PATH，其次常见 SDK 安装位置。
 * Windows / macOS / Linux 各自的默认 SDK 路径都会尝试。
 */
export function resolveAdbPath(): string {
  if (cachedAdbPath) {
    return cachedAdbPath;
  }

  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates: string[] = [];

  const envHome =
    process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '';
  if (envHome) {
    candidates.push(path.join(envHome, 'platform-tools', exe));
  }

  if (process.platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe),
    );
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      candidates.push(path.join(local, 'Android', 'Sdk', 'platform-tools', exe));
    }
  } else {
    candidates.push(
      path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe),
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedAdbPath = candidate;
      return candidate;
    }
  }

  // 回退：依赖 PATH 中的 adb。
  cachedAdbPath = exe;
  return exe;
}

/** 解析 `adb devices -l` 输出为设备列表。 */
export function parseAdbDevices(stdout: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  // 首行是 "List of devices attached"，跳过。
  const lines = stdout.split('\n').slice(1);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('*')) {
      continue;
    }
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] ?? 'unknown';
    if (!serial) {
      continue;
    }

    let model = '';
    for (const token of parts.slice(2)) {
      if (token.startsWith('model:')) {
        model = token.slice('model:'.length).replace(/_/g, ' ');
      }
    }

    devices.push({
      serial,
      model: model || serial,
      state,
      isEmulator: serial.startsWith('emulator-'),
    });
  }

  return devices;
}

/** 列出当前连接的 Android 设备 / 模拟器。adb 不可用时返回空数组。 */
export async function listAndroidDevices(): Promise<AndroidDevice[]> {
  try {
    const { stdout } = await execFileAsync(resolveAdbPath(), ['devices', '-l']);
    return parseAdbDevices(stdout);
  } catch {
    return [];
  }
}

/** 仅返回状态可用（device）的设备。 */
export async function listReadyAndroidDevices(): Promise<AndroidDevice[]> {
  return (await listAndroidDevices()).filter((d) => d.state === 'device');
}

/** 读取设备型号（ro.product.model），用于美化 picker 显示。 */
export async function getAndroidModel(serial: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveAdbPath(), [
      '-s',
      serial,
      'shell',
      'getprop',
      'ro.product.model',
    ]);
    const model = stdout.trim();
    return model || null;
  } catch {
    return null;
  }
}

/** 探测 adb 是否可用（用于非 macOS 平台的 preflight）。 */
export async function isAdbAvailable(): Promise<boolean> {
  try {
    await execFileAsync(resolveAdbPath(), ['version']);
    return true;
  } catch {
    return false;
  }
}
