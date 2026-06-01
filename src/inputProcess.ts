import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { INPUT_BIN } from './helperPaths';

export type InputEvent =
  | { type: 'tap'; x: number; y: number; hold?: number }
  | { type: 'touch'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { type: 'button-tap'; name: 'home' | 'lock' | 'side' | 'siri' }
  | { type: 'key-tap'; usage: number; modifiers?: number[] }
  | { type: 'text'; text: string };

export class InputProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private targetUdid: string | undefined;
  private inputBin: string = INPUT_BIN;

  start(udid?: string, inputBin: string = INPUT_BIN): void {
    if (this.proc && this.targetUdid === udid && this.inputBin === inputBin) {
      return;
    }
    this.stop();
    this.targetUdid = udid;
    this.inputBin = inputBin;

    const args = udid ? [udid] : [];
    this.proc = spawn(inputBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      // Keep stderr for debugging; no UI wiring in MVP.
      void chunk;
    });

    this.proc.on('error', () => {
      this.proc = null;
    });

    this.proc.on('exit', () => {
      this.proc = null;
    });
  }

  stop(): void {
    if (!this.proc) {
      return;
    }
    this.proc.stdin.end();
    this.proc.kill('SIGTERM');
    this.proc = null;
    this.targetUdid = undefined;
  }

  send(event: InputEvent): void {
    if (!this.proc?.stdin.writable) {
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(event)}\n`);
  }
}
