import { spawn } from 'child_process';
import { InputProcess } from './inputProcess';

/** USB HID usage: Cmd+V paste (after simctl pbcopy). */
const HID_V = 0x19;
const HID_LEFT_META = 0xe3;
/** USB HID usage: Return / Enter. */
const HID_ENTER = 0x28;

function pbcopyToDevice(udid: string, text: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('xcrun', ['simctl', 'pbcopy', udid], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    proc.on('error', (e) => {
      resolve({ ok: false, error: String(e.message || e) });
    });
    proc.on('exit', (code) => {
      resolve({
        ok: code === 0,
        error: code === 0 ? undefined : err.trim() || `pbcopy exit ${code}`,
      });
    });
    try {
      proc.stdin?.end(text);
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

export async function pasteTextToSimulator(
  input: InputProcess,
  udid: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const value = text.trim();
  if (!value) {
    return { ok: true };
  }
  if (value.length > 4096) {
    return { ok: false, error: '输入文字过长（上限 4096 字符）' };
  }

  try {
    const copied = await pbcopyToDevice(udid, value);
    if (!copied.ok) {
      return { ok: false, error: copied.error ?? 'simctl pbcopy 失败' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `simctl pbcopy 失败: ${message}` };
  }

  input.send({
    type: 'key-tap',
    usage: HID_V,
    modifiers: [HID_LEFT_META],
  });
  return { ok: true };
}

export function sendEnterKey(input: InputProcess): void {
  input.send({ type: 'key-tap', usage: HID_ENTER });
}

export async function sendSimulatorText(
  input: InputProcess,
  udid: string,
  text: string,
  submit: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = text.trim();
  if (trimmed) {
    const pasted = await pasteTextToSimulator(input, udid, trimmed);
    if (!pasted.ok) {
      return pasted;
    }
  }
  if (submit) {
    sendEnterKey(input);
  }
  return { ok: true };
}
