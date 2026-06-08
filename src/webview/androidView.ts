import type { ScrcpyVideoCodecId } from '@yume-chan/scrcpy';
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
  type VideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface IncomingPacket {
  type: 'configuration' | 'data';
  keyframe?: boolean;
  pts?: bigint;
  data: Uint8Array;
}

// AndroidMotionEventAction 数字值（与 host 端枚举一致）。
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

(function () {
  const vscode = acquireVsCodeApi();

  const stage = document.getElementById('android-stage') as HTMLElement | null;
  const statusEl = document.getElementById('android-status');
  const placeholder = document.getElementById('android-placeholder');
  const keyboardInput = document.getElementById(
    'android-kbd-input',
  ) as HTMLInputElement | null;

  let decoder: WebCodecsVideoDecoder | null = null;
  let renderElement: HTMLCanvasElement | HTMLVideoElement | null = null;
  let streamController: ReadableStreamDefaultController<IncomingPacket> | null =
    null;
  let pointerDown = false;

  function setStatus(text: string): void {
    if (statusEl) {
      statusEl.textContent = text;
    }
  }

  function createRenderer(): {
    renderer: VideoFrameRenderer;
    element: HTMLCanvasElement | HTMLVideoElement;
  } {
    if (WebGLVideoFrameRenderer.isSupported) {
      const renderer = new WebGLVideoFrameRenderer();
      return { renderer, element: renderer.canvas as HTMLCanvasElement };
    }
    const renderer = new BitmapVideoFrameRenderer();
    return { renderer, element: renderer.canvas as HTMLCanvasElement };
  }

  function teardownDecoder(): void {
    try {
      streamController?.close();
    } catch {
      // already closed
    }
    streamController = null;
    decoder?.dispose?.();
    decoder = null;
    if (renderElement && renderElement.parentElement) {
      renderElement.parentElement.removeChild(renderElement);
    }
    renderElement = null;
  }

  function startDecoder(codec: ScrcpyVideoCodecId): void {
    if (!WebCodecsVideoDecoder.isSupported) {
      setStatus('当前环境不支持 WebCodecs，无法解码视频');
      return;
    }
    teardownDecoder();

    const { renderer, element } = createRenderer();
    renderElement = element;
    element.id = 'android-screen';
    if (placeholder) {
      placeholder.hidden = true;
    }
    stage?.appendChild(element);

    decoder = new WebCodecsVideoDecoder({ codec, renderer });
    decoder.sizeChanged(({ width, height }) => {
      if (renderElement) {
        renderElement.style.aspectRatio = `${width} / ${height}`;
      }
    });

    const packetStream = new ReadableStream<IncomingPacket>({
      start(controller) {
        streamController = controller;
      },
    });

    void packetStream
      // decoder.writable 接收 ScrcpyMediaStreamPacket，结构一致。
      .pipeTo(decoder.writable as unknown as WritableStream<IncomingPacket>)
      .catch((err: unknown) => {
        setStatus(`解码中断：${err instanceof Error ? err.message : String(err)}`);
      });

    bindInput(element);
    setStatus('已连接 Android 设备');
  }

  function normCoords(
    el: HTMLElement,
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  function sendTouch(action: number, x: number, y: number): void {
    vscode.postMessage({ type: 'android-touch', action, x, y });
  }

  function bindInput(el: HTMLElement): void {
    el.addEventListener('mousedown', (e) => {
      pointerDown = true;
      const { x, y } = normCoords(el, e.clientX, e.clientY);
      sendTouch(ACTION_DOWN, x, y);
    });
    el.addEventListener('mousemove', (e) => {
      if (!pointerDown) {
        return;
      }
      const { x, y } = normCoords(el, e.clientX, e.clientY);
      sendTouch(ACTION_MOVE, x, y);
    });
    const release = (e: MouseEvent) => {
      if (!pointerDown) {
        return;
      }
      pointerDown = false;
      const { x, y } = normCoords(el, e.clientX, e.clientY);
      sendTouch(ACTION_UP, x, y);
    };
    el.addEventListener('mouseup', release);
    el.addEventListener('mouseleave', release);
  }

  function bindToolbar(): void {
    document
      .getElementById('android-btn-home')
      ?.addEventListener('click', () =>
        vscode.postMessage({ type: 'android-key', name: 'home' }),
      );
    document
      .getElementById('android-btn-back')
      ?.addEventListener('click', () =>
        vscode.postMessage({ type: 'android-key', name: 'back' }),
      );
    document
      .getElementById('android-btn-recent')
      ?.addEventListener('click', () =>
        vscode.postMessage({ type: 'android-key', name: 'recent' }),
      );
    document
      .getElementById('android-btn-refresh')
      ?.addEventListener('click', () =>
        vscode.postMessage({ type: 'refresh' }),
      );

    const sendText = () => {
      const text = keyboardInput?.value ?? '';
      if (!text) {
        return;
      }
      vscode.postMessage({ type: 'android-text', text });
      if (keyboardInput) {
        keyboardInput.value = '';
      }
    };
    document
      .getElementById('android-btn-kbd-send')
      ?.addEventListener('click', sendText);
    keyboardInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendText();
      }
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg?.type) {
      case 'android-metadata':
        startDecoder(msg.codec as ScrcpyVideoCodecId);
        break;
      case 'android-packet':
        streamController?.enqueue(msg.packet as IncomingPacket);
        break;
      case 'status':
        setStatus(msg.message ?? '');
        break;
      case 'error':
        setStatus(`错误：${msg.message}`);
        break;
      case 'android-stopped':
        teardownDecoder();
        if (placeholder) {
          placeholder.hidden = false;
        }
        break;
      default:
        break;
    }
  });

  bindToolbar();
  vscode.postMessage({ type: 'ready' });
})();
