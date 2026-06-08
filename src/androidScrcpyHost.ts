import { EventEmitter } from 'events';
import * as fs from 'fs';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions2_1 } from '@yume-chan/adb-scrcpy';
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  DefaultServerPath,
  ScrcpyControlMessageWriter,
  ScrcpyMediaStreamPacket,
  ScrcpyPointerId,
  ScrcpyVideoCodecId,
} from '@yume-chan/scrcpy';
import { Consumable, ReadableStream, WritableStream } from '@yume-chan/stream-extra';

/** scrcpy server 版本：必须与打包的 jar 版本完全一致。 */
export const SCRCPY_SERVER_VERSION = '2.7';

export interface AndroidVideoMetadata {
  codec: ScrcpyVideoCodecId;
  width: number;
  height: number;
}

/** 通过 postMessage 传给 webview 的视频包（保留 bigint pts，结构化克隆支持）。 */
export interface AndroidVideoPacket {
  type: 'configuration' | 'data';
  keyframe?: boolean;
  pts?: bigint;
  data: Uint8Array;
}

export interface AndroidScrcpyStartOptions {
  serial: string;
  serverJarPath: string;
  adbServerPort?: number;
  maxSize?: number;
  maxFps?: number;
  videoBitRate?: number;
}

/**
 * Host 端 scrcpy 客户端封装：连接本机 adb server、推送并启动 scrcpy server、
 * 把 H.264 视频包转发出去（供 webview 用 WebCodecs 解码），并把触控/按键
 * 事件注入设备。事件：metadata / packet / size / error / exit。
 */
export class AndroidScrcpyHost extends EventEmitter {
  private client: AdbScrcpyClient<AdbScrcpyOptions2_1<true>> | null = null;
  private controller: ScrcpyControlMessageWriter | undefined;
  private videoWidth = 0;
  private videoHeight = 0;
  private stopped = false;

  async start(options: AndroidScrcpyStartOptions): Promise<void> {
    this.stopped = false;

    const connector = new AdbServerNodeTcpConnector({
      host: '127.0.0.1',
      port: options.adbServerPort ?? 5037,
    });
    const serverClient = new AdbServerClient(connector);
    const adb = await serverClient.createAdb({ serial: options.serial });

    const jar = fs.readFileSync(options.serverJarPath);
    const jarStream = new ReadableStream<Consumable<Uint8Array>>({
      start(controller) {
        controller.enqueue(new Consumable(new Uint8Array(jar)));
        controller.close();
      },
    });
    await AdbScrcpyClient.pushServer(adb, jarStream);

    const scrcpyOptions = new AdbScrcpyOptions2_1<true>(
      {
        video: true,
        audio: false,
        control: true,
        maxSize: options.maxSize ?? 0,
        maxFps: options.maxFps ?? 0,
        videoBitRate: options.videoBitRate ?? 8_000_000,
      },
      { version: SCRCPY_SERVER_VERSION },
    );

    const client = await AdbScrcpyClient.start(
      adb,
      DefaultServerPath,
      scrcpyOptions,
    );
    this.client = client;
    this.controller = client.controller;

    // 消费 server 日志输出，避免连接阻塞。
    void client.output
      .pipeTo(new WritableStream<string>({ write: () => {} }))
      .catch(() => {});

    const videoStream = await client.videoStream;
    if (!videoStream) {
      throw new Error('scrcpy 未返回视频流');
    }

    this.videoWidth = videoStream.width;
    this.videoHeight = videoStream.height;
    this.emit('metadata', {
      codec: videoStream.metadata.codec,
      width: videoStream.width,
      height: videoStream.height,
    } as AndroidVideoMetadata);

    videoStream.sizeChanged(({ width, height }) => {
      this.videoWidth = width;
      this.videoHeight = height;
      this.emit('size', { width, height });
    });

    void videoStream.stream
      .pipeTo(
        new WritableStream<ScrcpyMediaStreamPacket>({
          write: (packet) => {
            const out: AndroidVideoPacket =
              packet.type === 'data'
                ? {
                    type: 'data',
                    keyframe: packet.keyframe,
                    pts: packet.pts,
                    data: packet.data,
                  }
                : { type: 'configuration', data: packet.data };
            this.emit('packet', out);
          },
        }),
      )
      .catch((err: unknown) => {
        if (!this.stopped) {
          this.emit('error', err instanceof Error ? err.message : String(err));
        }
      });

    void client.exited.then(() => {
      if (!this.stopped) {
        this.emit('exit');
      }
    });
  }

  /** action: AndroidMotionEventAction 的数字值（Down=0/Up=1/Move=2）。坐标为 0..1 归一化。 */
  async sendTouch(action: number, normX: number, normY: number): Promise<void> {
    if (!this.controller || !this.videoWidth || !this.videoHeight) {
      return;
    }
    const released = action === AndroidMotionEventAction.Up;
    await this.controller.injectTouch({
      action: action as AndroidMotionEventAction,
      pointerId: ScrcpyPointerId.Finger,
      pointerX: Math.round(normX * this.videoWidth),
      pointerY: Math.round(normY * this.videoHeight),
      videoWidth: this.videoWidth,
      videoHeight: this.videoHeight,
      pressure: released ? 0 : 1,
      actionButton: 0,
      buttons: released ? 0 : 1,
    });
  }

  async sendText(text: string): Promise<void> {
    if (!text) {
      return;
    }
    await this.controller?.injectText(text);
  }

  /** 按下并抬起一个 Android 按键。 */
  async tapKey(keyCode: AndroidKeyCode): Promise<void> {
    if (!this.controller) {
      return;
    }
    await this.controller.injectKeyCode({
      action: AndroidKeyEventAction.Down,
      keyCode,
      repeat: 0,
      metaState: 0,
    });
    await this.controller.injectKeyCode({
      action: AndroidKeyEventAction.Up,
      keyCode,
      repeat: 0,
      metaState: 0,
    });
  }

  async pressHome(): Promise<void> {
    await this.tapKey(AndroidKeyCode.AndroidHome);
  }

  async pressBack(): Promise<void> {
    await this.tapKey(AndroidKeyCode.AndroidBack);
  }

  async pressAppSwitch(): Promise<void> {
    await this.tapKey(AndroidKeyCode.AndroidAppSwitch);
  }

  get size(): { width: number; height: number } {
    return { width: this.videoWidth, height: this.videoHeight };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    this.controller = undefined;
    if (client) {
      await client.close().catch(() => {});
    }
  }
}
