// Electron 메인 프로세스
//  - 창 생성
//  - Python fusion_server.py 자식 프로세스 spawn + stdout 스트리밍
//  - VRAM 모니터링 (systeminformation, 폴백 psutil via python)
//  - 로컬 모델 디렉토리 스캔

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const si = require('systeminformation');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.PYTHON || 'python';  // 필요하면 python3 또는 절대경로
const SERVER = path.join(ROOT, 'backend', 'fusion_server.py');
const DEFAULT_MODELS_DIR = path.join(ROOT, 'backend', 'models');

// llama.cpp quantize 실행파일 경로 — 사용자 환경에 맞춰 수정
const LLAMA_CPP_QUANTIZE = process.env.LLAMA_QUANTIZE || 'quantize';

let win;
let pyProc = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

// ---------- 로컬 모델 스캔 ----------
// 디렉토리 내 하위 폴더(=모델) 또는 .safetensors/.gguf/.bin 파일을 모델로 간주
function scanModels(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const hasWeights = fs.readdirSync(full).some((f) =>
        /\.(safetensors|gguf|bin|pt|ckpt)$/i.test(f)
      );
      if (hasWeights) out.push({ name, path: full });
    } else if (/\.(safetensors|gguf|bin|pt|ckpt)$/i.test(name)) {
      out.push({ name, path: full });
    }
  }
  // Qwen 계열 상위 정렬
  out.sort((a, b) => Number(/qwen/i.test(b.name)) - Number(/qwen/i.test(a.name)) || a.name.localeCompare(b.name));
  return out;
}

// ---------- VRAM ----------
let vramTimer = null;
async function startVramMonitor() {
  try {
    const g = await si.graphics();
    const nvidia = g.controllers.find((c) => /nvidia/i.test(c.vendor));
    if (nvidia) {
      win.webContents.send('fusion:gpu', `${nvidia.model} (${Math.round(nvidia.vram || nvidia.vramDynamic || 0)} MB)`);
    } else if (g.controllers[0]) {
      win.webContents.send('fusion:gpu', g.controllers[0].model || 'Unknown GPU');
    }
  } catch (e) {
    win.webContents.send('fusion:gpu', 'GPU 정보 없음');
  }
  // 정기 폴링 — 시스템에 따라 메모리 사용량 근사치.
  vramTimer = setInterval(async () => {
    let usedMB = 0;
    try {
      const mem = await si.mem();     // 폴백: 시스템 RAM (대략치)
      usedMB = (mem.active / 1024 / 1024);
    } catch (e) { /* ignore */ }
    // NOTE: 진짜 GPU VRAM은 nvidia-smi로 따로 잡아야 함 — 추후 확장.
    win.webContents.send('fusion:vram', usedMB * 0.3); // 임시 추정치
  }, 2000);
}

function stopVramMonitor() {
  if (vramTimer) { clearInterval(vramTimer); vramTimer = null; }
}

// ---------- Python spawn ----------
function spawnFusion(payload) {
  const args = [SERVER, '--json', JSON.stringify(payload), '--quantize-bin', LLAMA_CPP_QUANTIZE];
  pyProc = spawn(PYTHON, args, { cwd: path.join(ROOT, 'backend') });

  let stdoutBuf = '';
  pyProc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handlePythonLine(line);
    }
  });
  pyProc.stderr.on('data', (chunk) => {
    win.webContents.send('fusion:log', chunk.toString().trim(), 'line-err');
  });
  pyProc.on('close', (code) => {
    win.webContents.send('fusion:log',
      code === 0 ? '[backend] 완료 (exit 0)' : `[backend] 종료 (exit ${code})`,
      code === 0 ? 'line-ok' : 'line-err');
    pyProc = null;
  });
}

function handlePythonLine(line) {
  line = line.trim();
  if (!line) return;
  // Python은 "LOG<TAB>메시지" 또는 "DONE" / "ERROR<TAB>메시지" 프로토콜 사용
  if (line.startsWith('DONE')) {
    win.webContents.send('fusion:log', '✓ 업로드 완료', 'line-ok');
    return;
  }
  if (line.startsWith('ERROR\t')) {
    win.webContents.send('fusion:log', '✗ ' + line.slice(6), 'line-err');
    return;
  }
  if (line.startsWith('VRAM\t')) {
    const mb = Number(line.slice(5));
    if (!Number.isNaN(mb)) win.webContents.send('fusion:vram', mb);
    return;
  }
  win.webContents.send('fusion:log', line);
}

// ---------- IPC ----------
ipcMain.handle('get-default-models-dir', () => DEFAULT_MODELS_DIR);
ipcMain.handle('pick-model-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('scan-models', (_e, dir) => scanModels(dir));
ipcMain.handle('start-merge', (e, payload) => {
  return new Promise((resolve, reject) => {
    if (pyProc) return reject(new Error('이미 실행 중'));
    spawnFusion(payload);
    pyProc.once('close', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code))));
  });
});
ipcMain.on('cancel-merge', () => {
  if (pyProc) { try { pyProc.kill('SIGTERM'); } catch (e) {} }
});

// ---------- 부트 ----------
app.whenReady().then(() => {
  createWindow();
  startVramMonitor();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => {
  stopVramMonitor();
  if (pyProc) try { pyProc.kill(); } catch (e) {}
  if (process.platform !== 'darwin') app.quit();
});
