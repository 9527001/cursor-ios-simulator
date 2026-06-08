import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const ISSUE_NEW_URL =
  'https://github.com/9527001/cursor-ios-simulator/issues/new';

export interface ErrorReport {
  /** 简短错误信息，用作 issue 标题与通知文案。 */
  message: string;
  /** 错误来源模块，便于归类（如 capture / preflight / helpers）。 */
  source?: string;
  /** 详细错误内容（堆栈 / 原始输出），缺省时回退到 message。 */
  detail?: string;
}

function readExtensionVersion(extensionPath: string): string {
  try {
    const pkgPath = path.join(extensionPath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 构造 issue 正文。使用全角【】小标题而非 markdown 的 `#`：
 * `#` 在 URL 中是 fragment 分隔符，经 openExternal 的 Uri round-trip 会被
 * 二次编码成 `%23`，导致正文出现 `%23%23`（见 issue #1）。全角字符与中文
 * 同样以 `%xx` 编码且可被正确还原，可彻底规避该问题。
 */
export function buildIssueBody(report: ErrorReport, extensionVersion: string): string {
  return [
    '【问题描述】',
    '',
    '<!-- 请补充复现步骤、期望行为等信息 -->',
    '',
    '【错误信息】',
    '',
    '```',
    report.detail ?? report.message,
    '```',
    '',
    '【运行环境】',
    '',
    `- 扩展版本: ${extensionVersion}`,
    `- 来源模块: ${report.source ?? 'unknown'}`,
    `- 编辑器: ${vscode.env.appName} ${vscode.version}`,
    `- 系统: ${os.type()} ${os.release()} (${os.arch()})`,
  ].join('\n');
}

/** 构造预填好标题与正文的 GitHub 新建 issue 链接。 */
export function buildIssueUrl(report: ErrorReport, extensionVersion: string): string {
  const title = `[错误] ${report.message}`.slice(0, 200);
  const body = buildIssueBody(report, extensionVersion);
  const query = `title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return `${ISSUE_NEW_URL}?${query}`;
}

/**
 * 弹出原生错误通知，提供「报告到 GitHub」与「复制详情」操作。
 * 点击报告时打开预填好的 GitHub 新建 issue 页面。
 */
export async function presentError(
  report: ErrorReport,
  extensionPath: string,
): Promise<void> {
  const REPORT = '报告到 GitHub';
  const COPY = '复制详情';

  const choice = await vscode.window.showErrorMessage(
    `iOS Simulator: ${report.message}`,
    REPORT,
    COPY,
  );

  if (choice === REPORT) {
    const version = readExtensionVersion(extensionPath);
    // 兜底：正文同时复制到剪贴板，即使预填异常也可直接粘贴。
    await vscode.env.clipboard.writeText(buildIssueBody(report, version));
    await vscode.env.openExternal(
      vscode.Uri.parse(buildIssueUrl(report, version)),
    );
  } else if (choice === COPY) {
    await vscode.env.clipboard.writeText(report.detail ?? report.message);
  }
}
