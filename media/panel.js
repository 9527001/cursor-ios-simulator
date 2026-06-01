(function () {
  const vscode = acquireVsCodeApi();

  const statusEl = document.getElementById('status');
  const devicePicker = /** @type {HTMLSelectElement} */ (
    document.getElementById('device-picker')
  );
  const placeholder = document.getElementById('placeholder');
  const mirror = /** @type {HTMLImageElement} */ (document.getElementById('screen'));
  const deviceInfo = document.getElementById('device-info');
  const keyboardInput = /** @type {HTMLInputElement} */ (
    document.getElementById('keyboard-input')
  );
  const btnAnnotate = document.getElementById('btn-annotate');
  const btnScreenshot = document.getElementById('btn-screenshot');
  const btnHome = document.getElementById('btn-home');
  const btnLock = document.getElementById('btn-lock');
  const btnSide = document.getElementById('btn-side');
  const btnSiri = document.getElementById('btn-siri');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnKbdSend = document.getElementById('btn-kbd-send');

  let annotateMode = false;
  let streamInfo = null;
  let activeDevice = null;
  let pickerDevices = [];
  let selectingDevice = false;
  let lastBlobUrl = null;
  /** @type {string | null} */
  let pendingBase64 = null;
  let rafScheduled = false;
  let decoding = false;
  let perfDisplayed = 0;
  let perfSkipped = 0;
  let perfDecodeTotal = 0;
  let perfDecodeCount = 0;
  let decodeStartedAt = 0;

  /** @type {{ x: number, y: number } | null} */
  let swipeStart = null;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function showMirror() {
    if (placeholder) placeholder.hidden = true;
    if (mirror) mirror.hidden = false;
  }

  function hideMirror() {
    if (placeholder) placeholder.hidden = false;
    if (mirror) mirror.hidden = true;
  }

  function revokeLastBlob() {
    if (lastBlobUrl) {
      URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = null;
    }
  }

  function scheduleFrameRender(base64) {
    pendingBase64 = base64;
    if (rafScheduled || decoding) {
      if (decoding && base64) {
        perfSkipped += 1;
      }
      return;
    }
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      const data = pendingBase64;
      pendingBase64 = null;
      if (!data || !mirror) {
        return;
      }

      decoding = true;
      decodeStartedAt = performance.now();
      const bytes = base64ToUint8Array(data);
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const prev = lastBlobUrl;
      lastBlobUrl = url;

      mirror.onload = () => {
        if (prev) {
          URL.revokeObjectURL(prev);
        }
        perfDisplayed += 1;
        perfDecodeTotal += performance.now() - decodeStartedAt;
        perfDecodeCount += 1;
        decoding = false;
        if (pendingBase64) {
          scheduleFrameRender(pendingBase64);
          pendingBase64 = null;
        }
      };
      mirror.onerror = () => {
        if (prev) {
          URL.revokeObjectURL(prev);
        }
        URL.revokeObjectURL(url);
        lastBlobUrl = null;
        decoding = false;
      };
      mirror.src = url;
      showMirror();
    });
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function renderDevicePicker() {
    if (!devicePicker) return;
    const prev = devicePicker.value;
    devicePicker.innerHTML = '';

    if (pickerDevices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '无 iPhone 模拟器';
      devicePicker.appendChild(opt);
      return;
    }

    for (const d of pickerDevices) {
      const opt = document.createElement('option');
      opt.value = d.udid;
      const stateTag = d.state === 'Booted' ? '●' : '○';
      opt.textContent = `${stateTag} ${d.name} (${d.runtime})`;
      devicePicker.appendChild(opt);
    }

    const target =
      activeDevice?.udid ||
      prev ||
      pickerDevices.find((d) => d.state === 'Booted')?.udid ||
      pickerDevices[0]?.udid ||
      '';
    devicePicker.value = target;
  }

  function normCoords(clientX, clientY) {
    const rect = mirror.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  function sendTypeKeys(submit) {
    const text = keyboardInput?.value ?? '';
    if (!text && !submit) return;
    vscode.postMessage({ type: 'type-keys', text, submit });
    if (keyboardInput) keyboardInput.value = '';
  }

  mirror.addEventListener('mousedown', (e) => {
    if (mirror.hidden) return;
    swipeStart = normCoords(e.clientX, e.clientY);
  });

  mirror.addEventListener('mouseup', (e) => {
    if (mirror.hidden || !swipeStart) return;
    const end = normCoords(e.clientX, e.clientY);
    const dx = Math.abs(end.x - swipeStart.x);
    const dy = Math.abs(end.y - swipeStart.y);

    if (annotateMode) {
      const comment = prompt('标注说明（可选）：') ?? '';
      vscode.postMessage({
        type: 'annotate',
        x: end.x,
        y: end.y,
        comment,
      });
    } else if (dx < 0.02 && dy < 0.02) {
      vscode.postMessage({ type: 'tap', x: end.x, y: end.y });
    } else {
      vscode.postMessage({
        type: 'swipe',
        x1: swipeStart.x,
        y1: swipeStart.y,
        x2: end.x,
        y2: end.y,
      });
    }
    swipeStart = null;
  });

  devicePicker?.addEventListener('change', () => {
    if (selectingDevice || !devicePicker.value) return;
    selectingDevice = true;
    setStatus('切换设备中…');
    vscode.postMessage({ type: 'select-device', udid: devicePicker.value });
    setTimeout(() => {
      selectingDevice = false;
    }, 500);
  });

  btnAnnotate?.addEventListener('click', () => {
    annotateMode = !annotateMode;
    btnAnnotate.classList.toggle('active', annotateMode);
    setStatus(annotateMode ? '标注模式：点击屏幕（含 a11y 树）' : '交互模式');
  });

  btnHome?.addEventListener('click', () => {
    vscode.postMessage({ type: 'button', name: 'home' });
  });

  btnLock?.addEventListener('click', () => {
    vscode.postMessage({ type: 'button', name: 'lock' });
  });

  btnSide?.addEventListener('click', () => {
    vscode.postMessage({ type: 'button', name: 'side' });
  });

  btnSiri?.addEventListener('click', () => {
    vscode.postMessage({ type: 'button', name: 'siri' });
  });

  btnScreenshot?.addEventListener('click', () => {
    vscode.postMessage({ type: 'screenshot' });
  });

  btnRefresh?.addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  btnKbdSend?.addEventListener('click', () => sendTypeKeys(false));

  keyboardInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendTypeKeys(false);
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'frame':
        scheduleFrameRender(msg.data);
        break;
      case 'stream-started':
        streamInfo = msg.info;
        setStatus(`${msg.info.deviceName} · ${msg.info.pixelWidth}×${msg.info.pixelHeight}`);
        if (deviceInfo) {
          deviceInfo.textContent = `${msg.info.deviceName} (${msg.info.deviceUDID.slice(0, 8)}…)`;
        }
        break;
      case 'no-booted-device':
        streamInfo = null;
        hideMirror();
        revokeLastBlob();
        setStatus('无 booted 模拟器');
        if (deviceInfo) deviceInfo.textContent = '';
        break;
      case 'devices':
        pickerDevices = msg.picker ?? [];
        activeDevice = msg.active ?? null;
        renderDevicePicker();
        if (activeDevice && !streamInfo) {
          setStatus(`已选 ${activeDevice.name}，等待画面…`);
        }
        break;
      case 'active-device':
        activeDevice = msg.active ?? null;
        if (activeDevice && devicePicker) {
          devicePicker.value = activeDevice.udid;
        }
        break;
      case 'status':
        setStatus(msg.message ?? '');
        break;
      case 'preflight-failed':
        streamInfo = null;
        hideMirror();
        revokeLastBlob();
        if (placeholder) {
          const hint = msg.hint ? `\n\n${msg.hint}` : '';
          placeholder.innerHTML =
            `<p>${msg.message ?? 'iOS Simulator 不可用。'}</p>` +
            `<p class="hint">${hint.replace(/\n/g, '<br>')}</p>`;
        }
        setStatus('环境检查未通过');
        break;
      case 'error':
        setStatus(`错误: ${msg.message}`);
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });

  setInterval(() => {
    if (perfDisplayed === 0 && perfSkipped === 0) {
      return;
    }
    vscode.postMessage({
      type: 'perf-report',
      displayed: perfDisplayed,
      skipped: perfSkipped,
      avgDecodeMs:
        perfDecodeCount > 0 ? perfDecodeTotal / perfDecodeCount : 0,
    });
    perfDisplayed = 0;
    perfSkipped = 0;
    perfDecodeTotal = 0;
    perfDecodeCount = 0;
  }, 3000);
})();
