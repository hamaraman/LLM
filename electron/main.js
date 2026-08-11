// Electron 메인 프로세스
//  - 창 생성
//  - Python fusion_server.py 자식 프로세스 spawn + stdout 스트리밍
//  - VRAM 모니터링 (nvidia-smi 우선, 폴백 시스템 RAM)
//  - 로컬 모델 디렉토리 스캔
//  - 설정 파일(JSON) 로드/저장

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const si = require('systeminformation');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.PYTHON || 'python';
const SERVER = path.join(ROOT, 'backend', 'fusion_server.py');
const DEFAULT_MODELS_DIR = path.join(ROOT, 'backend', 'models');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// llama.cpp quantize 실행파일 경로
const LLAMA_CPP_QUANTIZE = process.env.LLAMA_QUANTIZE || 'quantize';

let win;
let pyProc = null;

// ---------- 설정 파일 ----------
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch (e) { /* 무시 */ }
  return {};
}
function saveSettings(obj) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf-8'); }
  catch (e) { console.error('settings save failed', e); }
}

// ---------- 창 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#0d1117',
    webPreferences: { preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

// ---------- 로컬 모델 스캔 ----------
function scanModels(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        const hasWeights = fs.readdirSync(full).some((f) =>
          /\.(safetensors|gguf|bin|pt|ckpt)$/i.test(f));
        if (hasWeights) out.push({ name, path: full });
      } else if (/\.(safetensors|gguf|bin|pt|ckpt)$/i.test(name)) {
        out.push({ name, path: full });
      }
    } catch (e) { /* 권한 등 무시 */ }
  }
  out.sort((a, b) =>
    Number(/qwen/i.test(b.name)) - Number(/qwen/i.test(a.name)) || a.name.localeCompare(b.name));
  return out;
}

// ---------- VRAM (nvidia-smi 우선) ----------
let _hasNvidiaSmi = null;
function checkNvidiaSmi() {
  if (_hasNvidiaSmi !== null) return Promise.resolve(_hasNvidiaSmi);
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'nvidia-smi' : 'nvidia-smi';
    execFile(cmd, ['--query-gpu=name', '--format=csv,noheader'], (err, stdout) => {
      _hasNvidiaSmi = !err && /nvidia|geforce|rtx|quadro/i.test(stdout);
      resolve(_hasNvidiaSmi);
    });
  });
}

async function queryVramNvidia() {
  return new Promise((resolve) => {
    execFile('nvidia-smi',
      ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
      (err, stdout) => {
        if (err) return resolve(null);
        const n = parseInt(stdout, 10);
        resolve(Number.isNaN(n) ? null : n);
      });
  });
}

let vramTimer = null;
async function startVramMonitor() {
  // GPU 이름
  try {
    const g = await si.graphics();
    const nvidia = g.controllers.find((c) => /nvidia/i.test(c.vendor));
    const ctrl = nvidia || g.controllers[0];
    // VRAM 총량: vram 단위는 MB. 일부 환경에선 vramDynamic 에만 있음.
    let totalMB = 8192;
    if (ctrl) {
      const v = (typeof ctrl.vram === 'number' && ctrl.vram > 0) ? ctrl.vram
              : (typeof ctrl.vramDynamic === 'number' && ctrl.vramDynamic > 0) ? ctrl.vramDynamic
              : 8192;
      totalMB = v;
    }
    const name = ctrl ? `${ctrl.model || 'Unknown GPU'}` : 'Unknown GPU';
    win.webContents.send('fusion:gpu', name);
    win.webContents.send('fusion:vram-limit', totalMB);
  } catch (e) {
    win.webContents.send('fusion:gpu', 'GPU 정보 없음');
    win.webContents.send('fusion:vram-limit', 8192);
  }

  // 정기 폴링 — nvidia-smi 우선, 없으면 systeminformation RAM 폴백
  vramTimer = setInterval(async () => {
    let usedMB = null;
    if (await checkNvidiaSmi()) {
      usedMB = await queryVramNvidia();
    }
    if (usedMB === null) {
      try {
        const mem = await si.mem();
        usedMB = (mem.active / 1024 / 1024) * 0.3; // 폴백 추정치
      } catch (e) { usedMB = 0; }
    }
    win.webContents.send('fusion:vram', usedMB);
  }, 2000);
}
function stopVramMonitor() { if (vramTimer) { clearInterval(vramTimer); vramTimer = null; } }

// ---------- Python spawn ----------
function spawnFusion(payload) {
  const args = [SERVER, '--json', JSON.stringify(payload), '--quantize-bin', LLAMA_CPP_QUANTIZE];
  pyProc = spawn(PYTHON, args, { cwd: path.join(ROOT, 'backend') });
  let buf = '';
  pyProc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handlePythonLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  pyProc.stderr.on('data', (chunk) =>
    win.webContents.send('fusion:log', chunk.toString().trim(), 'line-err'));
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
  if (line.startsWith('DONE')) { win.webContents.send('fusion:log', '✓ 업로드 완료', 'line-ok'); return; }
  if (line.startsWith('ERROR\t')) { win.webContents.send('fusion:log', '✗ ' + line.slice(6), 'line-err'); return; }
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
ipcMain.handle('start-merge', (e, payload) => new Promise((resolve, reject) => {
  if (pyProc) return reject(new Error('이미 실행 중'));
  spawnFusion(payload);
  pyProc.once('close', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code))));
}));
ipcMain.on('cancel-merge', () => {
  if (pyProc) { try { pyProc.kill('SIGTERM'); } catch (e) {} }
});

// 설정 파일
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, obj) => { saveSettings(obj); return true; });

// VRAM 수동 쿼리
ipcMain.handle('vram:query', async () => {
  if (await checkNvidiaSmi()) return await queryVramNvidia();
  return null;
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
