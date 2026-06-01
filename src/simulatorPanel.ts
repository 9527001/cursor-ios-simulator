import * as vscode from 'vscode';
import { CaptureProcess, StreamStartedInfo } from './captureProcess';
import { InputProcess } from './inputProcess';
import {
  bootDeviceHeadless,
  ensureDefaultBooted,
  getDeviceSnapshot,
  pickPreferredBootedDevice,
  SimDevice,
} from './deviceManager';
import {
  ensureHelperBinariesAsync,
  findHelperBinariesSync,
  HelperBinaries,
} from './helperPaths';
import {
  elementDisplayName,
  findElementAtPoint,
  listElementsOnScreen,
} from './accessibilityService';
import { sendAnnotationToChat } from './chatService';
import { sendSimulatorText } from './keyboardInput';
import { runPreflight } from './preflightService';
import { captureSimulatorScreenshot } from './screenshotService';
import { prefetchXcodeBuildMcp } from './xcodebuildMcpCli';
import { FrameRelay } from './frameRelay';
import {
  captureArgsDiffer,
  SmoothnessTuner,
  StreamProfile,
} from './smoothnessTuner';

export class SimulatorPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ios-simulator.panel';

  private view?: vscode.WebviewView;
  private capture = new CaptureProcess();
  private input = new InputProcess();
  private streamInfo: StreamStartedInfo | null = null;
  private activeDevice: SimDevice | null = null;
  private pickerDevices: SimDevice[] = [];
  private preflightOk = false;
  private helperBins: HelperBinaries | null = null;
  private helpersReadyPromise: Promise<HelperBinaries> | null = null;
  private startupGeneration = 0;
  private frameRelay: FrameRelay;
  private tuner: SmoothnessTuner | null = null;
  private appliedProfile: StreamProfile | null = null;
  private evalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionPath: string,
  ) {
    this.frameRelay = new FrameRelay(this.readMaxFps(), (jpeg) => {
      if (!this.view?.webview) {
        return;
      }
      this.view.webview.postMessage({
        type: 'frame',
        data: jpeg.toString('base64'),
      });
    });

    this.capture.on('frame', (jpeg: Buffer) => {
      this.frameRelay.push(jpeg, this.view?.webview, !!this.view?.visible);
    });

    this.capture.on('status', (status: unknown) => {
      if (!this.view?.webview) {
        return;
      }
      const s = status as { type?: string };
      if (s.type === 'stream-started') {
        this.streamInfo = status as StreamStartedInfo;
        this.syncActiveDeviceFromStream(this.streamInfo);
        this.view.webview.postMessage({
          type: 'stream-started',
          info: this.streamInfo,
        });
      } else if (s.type === 'no-booted-device') {
        this.streamInfo = null;
        this.view.webview.postMessage({ type: 'no-booted-device' });
      } else if (s.type === 'error') {
        this.view.webview.postMessage({
          type: 'error',
          message: (status as { message: string }).message,
        });
      }
    });

    this.capture.on('exit', () => {
      if (this.view?.visible) {
        setTimeout(() => this.startStream(), 1500);
      }
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this.runStartupFlow();
          break;
        case 'tap':
          this.input.send({ type: 'tap', x: msg.x, y: msg.y });
          break;
        case 'swipe':
          this.handleSwipe(msg.x1, msg.y1, msg.x2, msg.y2);
          break;
        case 'button':
          this.input.send({
            type: 'button-tap',
            name: msg.name ?? 'home',
          });
          break;
        case 'annotate':
          await this.submitAnnotation(msg.x, msg.y, msg.comment ?? '');
          break;
        case 'type-keys':
          await this.handleTypeKeys(msg.text ?? '', !!msg.submit);
          break;
        case 'screenshot':
          await this.handleScreenshot();
          break;
        case 'select-device':
          await this.handleSelectDevice(msg.udid as string);
          break;
        case 'refresh':
          this.runStartupFlow();
          break;
        case 'perf-report':
          this.handlePerfReport(msg);
          break;
        default:
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.runStartupFlow();
      } else {
        this.stopStream();
      }
    });

    webviewView.onDidDispose(() => {
      this.stopStream();
      this.view = undefined;
    });
  }

  refresh(): void {
    if (!this.view) {
      void vscode.commands.executeCommand('ios-simulator.panel.focus');
      return;
    }
    void this.runStartupFlow();
  }

  dispose(): void {
    this.stopSmoothnessMonitor();
    this.stopStream();
  }

  private readAdaptiveSmoothness(): boolean {
    return vscode.workspace
      .getConfiguration('iosSimulator')
      .get<boolean>('adaptiveSmoothness', true);
  }

  private readAutoBootEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('iosSimulator')
      .get<boolean>('autoBoot', true);
  }

  private readPrefetchEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('iosSimulator')
      .get<boolean>('prefetchXcodebuildMcp', true);
  }

  private readMaxFps(): number {
    const fps = vscode.workspace
      .getConfiguration('iosSimulator')
      .get<number>('maxFps', 20);
    return Math.min(60, Math.max(8, fps));
  }

  /** Non-blocking startup: stream first, devices/auto-boot/prefetch in background. */
  private runStartupFlow(): void {
    const generation = ++this.startupGeneration;

    const pf = runPreflight();
    if (!pf.ok) {
      this.preflightOk = false;
      this.view?.webview.postMessage({
        type: 'preflight-failed',
        message: pf.message ?? 'Preflight failed.',
        hint: pf.hint ?? '',
      });
      return;
    }
    this.preflightOk = true;
    this.initSmoothnessTuner();

    this.view?.webview.postMessage({ type: 'status', message: '正在连接…' });
    void this.startStreamFast();

    void this.runStartupBackground(generation);
  }

  private initSmoothnessTuner(): void {
    this.stopSmoothnessMonitor();
    if (!this.readAdaptiveSmoothness()) {
      this.tuner = null;
      this.appliedProfile = null;
      this.frameRelay.setMaxFps(this.readMaxFps());
      return;
    }

    this.tuner = new SmoothnessTuner({
      relayFpsMax: this.readMaxFps(),
      relayFpsMin: 8,
      widthMin: 320,
      widthMax: 640,
    });
    this.appliedProfile = this.tuner.getProfile();
    this.frameRelay.setMaxFps(this.appliedProfile.relayFps);
    this.startSmoothnessMonitor();
  }

  private startSmoothnessMonitor(): void {
    if (!this.tuner || this.evalTimer) {
      return;
    }
    this.evalTimer = setInterval(() => this.runSmoothnessEval(), 3000);
  }

  private stopSmoothnessMonitor(): void {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
  }

  private handlePerfReport(msg: {
    displayed?: number;
    skipped?: number;
    avgDecodeMs?: number;
  }): void {
    if (!this.tuner) {
      return;
    }
    this.tuner.ingestWeb({
      displayed: msg.displayed ?? 0,
      skipped: msg.skipped ?? 0,
      avgDecodeMs: msg.avgDecodeMs ?? 0,
    });
  }

  private runSmoothnessEval(): void {
    if (!this.tuner || !this.view?.visible) {
      return;
    }

    this.tuner.ingestHost(this.frameRelay.consumeStats());
    const result = this.tuner.evaluate();
    if (!result) {
      return;
    }

    this.applyStreamProfile(result.profile);
    const base = this.streamInfo
      ? `${this.streamInfo.deviceName} · ${this.streamInfo.pixelWidth}×${this.streamInfo.pixelHeight}`
      : '已连接';
    this.view.webview.postMessage({
      type: 'stream-profile',
      hint: this.tuner.formatStatusHint(),
      reason: result.reason,
    });
    this.view.webview.postMessage({
      type: 'status',
      message: `${base} · 自适应 ${this.tuner.formatStatusHint()}`,
    });
  }

  private getActiveProfile(): StreamProfile {
    if (this.readAdaptiveSmoothness() && this.appliedProfile) {
      return this.appliedProfile;
    }
    return {
      relayFps: this.readMaxFps(),
      captureMaxWidth: 540,
      captureMaxFps: 30,
      jpegQuality: 0.42,
    };
  }

  private applyStreamProfile(profile: StreamProfile): void {
    const prev = this.appliedProfile;
    this.appliedProfile = profile;
    this.frameRelay.setMaxFps(profile.relayFps);

    if (!prev || captureArgsDiffer(prev, profile)) {
      this.restartCaptureOnly();
    }
  }

  private restartCaptureOnly(): void {
    const bins = this.helperBins ?? findHelperBinariesSync(this.extensionPath);
    if (!bins || !this.view?.visible) {
      return;
    }

    const profile = this.getActiveProfile();
    const udid = this.activeDevice?.udid;
    this.frameRelay.reset();
    this.capture.stop();
    this.capture.start(udid, bins.capture, {
      maxWidth: profile.captureMaxWidth,
      maxFps: profile.captureMaxFps,
      quality: profile.jpegQuality,
    });
  }

  private async runStartupBackground(generation: number): Promise<void> {
    try {
      const { booted, picker } = await getDeviceSnapshot();
      if (generation !== this.startupGeneration || !this.view) {
        return;
      }

      this.pickerDevices = picker;
      if (!this.activeDevice) {
        this.activeDevice = await pickPreferredBootedDevice({ quick: true });
      }
      this.view.webview.postMessage({
        type: 'devices',
        booted,
        picker,
        active: this.activeDevice,
      });

      if (booted.length === 0 && this.readAutoBootEnabled()) {
        this.view.webview.postMessage({
          type: 'status',
          message: '后台启动默认模拟器…',
        });
        const device = await ensureDefaultBooted();
        if (generation !== this.startupGeneration || !this.view) {
          return;
        }
        if (device) {
          this.activeDevice = device;
          const snap = await getDeviceSnapshot(true);
          this.pickerDevices = snap.picker;
          this.view.webview.postMessage({
            type: 'devices',
            booted: snap.booted,
            picker: snap.picker,
            active: this.activeDevice,
          });
          this.restartStream();
        }
      }

      if (this.readPrefetchEnabled()) {
        prefetchXcodeBuildMcp();
      }
    } catch (err) {
      if (generation !== this.startupGeneration || !this.view) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.view.webview.postMessage({ type: 'error', message });
    }
  }

  private async startStreamFast(): Promise<void> {
    const syncBins = findHelperBinariesSync(this.extensionPath);
    if (syncBins) {
      this.helperBins = syncBins;
      this.startStream();
      return;
    }

    this.view?.webview.postMessage({
      type: 'status',
      message: '正在准备 native helpers…',
    });

    try {
      const bins = await this.ensureHelpersReady();
      this.helperBins = bins;
      this.startStream();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'error', message });
    }
  }

  private ensureHelpersReady(): Promise<HelperBinaries> {
    if (this.helperBins) {
      return Promise.resolve(this.helperBins);
    }
    if (!this.helpersReadyPromise) {
      this.helpersReadyPromise = ensureHelperBinariesAsync(this.extensionPath).finally(
        () => {
          this.helpersReadyPromise = null;
        },
      );
    }
    return this.helpersReadyPromise;
  }

  private async refreshDevices(): Promise<void> {
    const { booted, picker } = await getDeviceSnapshot(true);
    this.pickerDevices = picker;
    if (!this.activeDevice) {
      this.activeDevice = await pickPreferredBootedDevice({ quick: true });
    }
    this.view?.webview.postMessage({
      type: 'devices',
      booted,
      picker: this.pickerDevices,
      active: this.activeDevice,
    });
  }

  private syncActiveDeviceFromStream(info: StreamStartedInfo): void {
    const fromPicker = this.pickerDevices.find((d) => d.udid === info.deviceUDID);
    if (fromPicker) {
      this.activeDevice = { ...fromPicker, state: 'Booted' };
    } else {
      this.activeDevice = {
        udid: info.deviceUDID,
        name: info.deviceName,
        state: 'Booted',
        runtime: '',
      };
    }
    this.view?.webview.postMessage({
      type: 'active-device',
      active: this.activeDevice,
    });
  }

  private async handleSelectDevice(udid: string): Promise<void> {
    const device = this.pickerDevices.find((d) => d.udid === udid);
    if (!device) {
      return;
    }

    this.view?.webview.postMessage({
      type: 'status',
      message: `正在启动 ${device.name}…`,
    });

    try {
      await bootDeviceHeadless(udid);
      this.activeDevice = { ...device, state: 'Booted' };
      await this.refreshDevices();
      this.restartStream();
      this.view?.webview.postMessage({
        type: 'status',
        message: `已连接 ${device.name}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'error', message });
    }
  }

  private async handleTypeKeys(text: string, submit: boolean): Promise<void> {
    if (!text.trim() && !submit) {
      return;
    }
    const deviceUdid = this.activeDevice?.udid ?? this.streamInfo?.deviceUDID;
    if (!deviceUdid) {
      this.view?.webview.postMessage({
        type: 'error',
        message: '无可用设备，无法输入文字',
      });
      return;
    }

    const result = await sendSimulatorText(this.input, deviceUdid, text, submit);
    if (!result.ok) {
      this.view?.webview.postMessage({
        type: 'error',
        message: result.error ?? '键盘输入失败',
      });
      return;
    }
    this.view?.webview.postMessage({ type: 'status', message: '文字已发送' });
  }

  private async handleScreenshot(): Promise<void> {
    const deviceUdid = this.activeDevice?.udid ?? this.streamInfo?.deviceUDID;
    if (!deviceUdid) {
      this.view?.webview.postMessage({
        type: 'error',
        message: '无可用设备，无法截图',
      });
      return;
    }

    this.view?.webview.postMessage({ type: 'status', message: '正在保存截图…' });
    const result = await captureSimulatorScreenshot(deviceUdid);
    if (!result.ok) {
      this.view?.webview.postMessage({
        type: 'error',
        message: result.error ?? '截图失败',
      });
      return;
    }

    this.view?.webview.postMessage({
      type: 'status',
      message: `截图已保存：${result.path}`,
    });
    void vscode.window.showInformationMessage(`截图已保存到桌面：${result.path}`);
  }

  private startStream(): void {
    if (!this.view?.visible) {
      return;
    }
    if (!this.preflightOk && !runPreflight().ok) {
      return;
    }

    const bins =
      this.helperBins ?? findHelperBinariesSync(this.extensionPath);
    if (!bins) {
      void this.startStreamFast();
      return;
    }

    const profile = this.getActiveProfile();
    this.frameRelay.setMaxFps(profile.relayFps);
    const udid = this.activeDevice?.udid;
    this.capture.start(udid, bins.capture, {
      maxWidth: profile.captureMaxWidth,
      maxFps: profile.captureMaxFps,
      quality: profile.jpegQuality,
    });
    this.input.start(udid, bins.input);
  }

  private restartStream(): void {
    this.frameRelay.reset();
    this.capture.stop();
    this.input.stop();
    this.startStream();
  }

  private stopStream(): void {
    this.frameRelay.reset();
    this.capture.stop();
    this.input.stop();
  }

  private handleSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void {
    this.input.send({ type: 'touch', phase: 'down', x: x1, y: y1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.input.send({
        type: 'touch',
        phase: 'move',
        x: x1 + (x2 - x1) * t,
        y: y1 + (y2 - y1) * t,
      });
    }
    this.input.send({ type: 'touch', phase: 'up', x: x2, y: y2 });
  }

  private async submitAnnotation(
    x: number,
    y: number,
    comment: string,
  ): Promise<void> {
    const device = this.activeDevice;
    const info = this.streamInfo;
    const px = info ? Math.round(x * info.pixelWidth) : null;
    const py = info ? Math.round(y * info.pixelHeight) : null;

    let matchedElement: ReturnType<typeof findElementAtPoint> = null;
    let a11yError: string | undefined;

    const deviceUdid = device?.udid ?? info?.deviceUDID;
    if (deviceUdid && info) {
      const a11y = await listElementsOnScreen(deviceUdid);
      if (a11y.ok) {
        matchedElement = findElementAtPoint(a11y.elements, x, y, info);
      } else {
        a11yError = a11y.error;
      }
    }

    const lines = [
      '## Simulator Annotation',
      '',
      comment ? `- **Comment**: ${comment}` : '- **Comment**: _(none)_',
    ];

    if (matchedElement) {
      const label = elementDisplayName(matchedElement);
      lines.push(`- **Element**: "${label}" (${matchedElement.type ?? 'unknown'})`);
      if (matchedElement.identifier) {
        lines.push(`- **Identifier**: \`${matchedElement.identifier}\``);
      }
      const coord = matchedElement.coordinates;
      if (coord) {
        lines.push(
          `- **Frame**: (${coord.x}, ${coord.y}, ${coord.width}, ${coord.height}) pt`,
        );
      }
    } else if (a11yError) {
      lines.push(`- **A11y lookup**: failed (${a11yError})`);
    }

    lines.push(`- **Normalized**: (${x.toFixed(4)}, ${y.toFixed(4)})`);
    if (px !== null && py !== null) {
      lines.push(`- **Pixel**: (${px}, ${py})`);
    }
    if (device) {
      lines.push(`- **Device**: ${device.name} (${device.udid})`);
    }
    if (info) {
      lines.push(
        `- **Viewport**: ${info.pixelWidth}×${info.pixelHeight}px @${info.scale}x`,
      );
    }
    lines.push('', '请修复上述 UI 问题。');

    const markdown = lines.join('\n');
    const target = await sendAnnotationToChat(markdown);
    if (target === 'chat') {
      void vscode.window.showInformationMessage(
        matchedElement
          ? `标注已发送到 Chat（命中 "${elementDisplayName(matchedElement)}"）`
          : '标注已发送到 Chat，可直接发送或继续编辑。',
      );
      return;
    }

    void vscode.window.showInformationMessage(
      matchedElement
        ? `已复制标注（命中 "${elementDisplayName(matchedElement)}"）`
        : 'Chat 不可用，标注已复制到剪贴板。',
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>iOS Simulator</title>
</head>
<body>
  <header class="toolbar">
    <select id="device-picker" title="选择模拟器">
      <option value="">加载设备…</option>
    </select>
    <span id="status" class="status">Connecting…</span>
    <div class="toolbar-actions">
      <button id="btn-annotate" title="标注模式">🎯</button>
      <button id="btn-screenshot" title="截图到桌面">📷</button>
      <button id="btn-home" title="Home">⌂</button>
      <button id="btn-lock" title="Lock">🔒</button>
      <button id="btn-side" title="Side Button">⎈</button>
      <button id="btn-siri" title="Siri">🎙</button>
      <button id="btn-refresh" title="Refresh">↻</button>
    </div>
  </header>
  <main id="stage">
    <div id="placeholder">
      <p>等待 booted 模拟器…</p>
      <p class="hint">从上方选择设备 Boot，或开启设置 <code>iosSimulator.autoBoot</code></p>
    </div>
    <img id="screen" alt="Simulator mirror" hidden />
  </main>
  <footer class="footer">
    <div id="device-info"></div>
    <div id="keyboard-bar">
      <input id="keyboard-input" type="text" placeholder="输入文字，Enter 发送" />
      <button id="btn-kbd-send" title="发送">⏎</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
