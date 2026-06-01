import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  message?: string;
  hint?: string;
  detail?: string;
  developerDir?: string;
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').find((line) => line.trim())?.trim() ?? '';
}

export function runPreflight(): PreflightResult {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      reason: 'platform',
      message: 'iOS Simulator 需要 macOS。',
      detail: `platform=${process.platform}`,
    };
  }

  const xcrunFind = spawnSync('/usr/bin/xcrun', ['-find', 'simctl'], {
    encoding: 'utf8',
  });
  if (xcrunFind.status !== 0) {
    return {
      ok: false,
      reason: 'xcrun',
      message: '本机未正确配置 Xcode 开发者工具。',
      hint: '安装 Xcode 后运行：sudo xcode-select -s /Applications/Xcode.app',
      detail: firstLine(xcrunFind.stderr),
    };
  }

  const sel = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' });
  const devDir = (sel.stdout ?? '').trim();
  if (sel.status !== 0 || !devDir) {
    return {
      ok: false,
      reason: 'xcode-select',
      message: '无法确定 Xcode 开发者目录。',
      hint: '运行：sudo xcode-select -s /Applications/Xcode.app',
      detail: firstLine(sel.stderr),
    };
  }

  if (!/Xcode.*\.app/i.test(devDir)) {
    return {
      ok: false,
      reason: 'clt-only',
      message: '当前激活的是 Command Line Tools，iOS Simulator 需要完整 Xcode。',
      hint: '安装 Xcode 后运行：sudo xcode-select -s /Applications/Xcode.app',
      detail: `DEVELOPER_DIR=${devDir}`,
    };
  }

  const simKit = path.join(devDir, 'Library/PrivateFrameworks/SimulatorKit.framework');
  if (!fs.existsSync(simKit)) {
    return {
      ok: false,
      reason: 'simkit',
      message: '当前 Xcode 安装中未找到 SimulatorKit。',
      hint: '请先打开 Xcode 完成组件安装，然后重试。',
      detail: simKit,
    };
  }

  return { ok: true, developerDir: devDir };
}

export function assertPreflight(): void {
  const result = runPreflight();
  if (!result.ok) {
    const hint = result.hint ? `\n${result.hint}` : '';
    throw new Error(`${result.message ?? 'Preflight failed.'}${hint}`);
  }
}
