// LLM Fusion Studio 진단 도우미 (npm run doctor)
// 환경 점검: Node/Electron 버전, Python, mergekit, huggingface_hub, quantize, convert 스크립트, nvidia-smi
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const c = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', mut: '\x1b[90m', b: '\x1b[1m', r: '\x1b[0m' };
let warn = 0, err = 0;

function head(t) { console.log(`\n${c.b}─ ${t} ${c.r}`); }
function ok(msg) { console.log(`  ${c.ok}✓${c.r} ${msg}`); }
function warn_(msg) { console.log(`  ${c.warn}!${c.r} ${msg}`); warn++; }
function bad(msg) { console.log(`  ${c.err}✗${c.r} ${msg}`); err++; }
function info(msg) { console.log(`  ${c.mut}${msg}${c.r}`); }

function cmdExists(cmd) {
  try { execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>NUL`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function runSafe(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// ----- Node / Electron -----
head('Node & Electron');
ok(`Node ${process.version} / ${process.platform}-${process.arch}`);
try {
  const el = require.resolve('electron');
  ok('Electron 패키지 발견: ' + path.dirname(el));
} catch { bad('Electron 설치 안 됨 — npm install 먼저'); info('cd ' + ROOT + ' && npm install'); }

// ----- Python -----
head('Python');
const pyCandidates = ['python', 'python3', 'py'];
let py = null, pyVer = null;
for (const p of pyCandidates) {
  pyVer = runSafe(p, ['--version']);
  if (pyVer) { py = p; break; }
}
if (py) {
  ok(`Python: ${py} → ${pyVer}`);
  info('PYTHON 환경변수로 다른 인터프리터 지정 가능');
} else {
  bad('Python 인터프리터를 못 찾음');
}

// ----- Python 패키지 -----
if (py) {
  head('Python 패키지');
  for (const pkg of ['mergekit', 'huggingface_hub', 'torch', 'transformers']) {
    const v = runSafe(py, ['-c', `import ${pkg}; print(getattr(${pkg}, '__version__', '?'))`]);
    if (v) ok(`${pkg} ${v}`); else warn_(`${pkg} 없음 — pip install -r backend/requirements.txt`);
  }
}

// ----- llama.cpp 도구 -----
head('llama.cpp 빌드 도구');
const Q = process.env.LLAMA_QUANTIZE || 'quantize';
const CONV = process.env.LLAMA_CONVERT || '';
if (cmdExists('quantize') || (fs.existsSync(Q) && fs.statSync(Q).isFile())) {
  ok(`quantize: ${Q}`);
} else {
  warn_(`quantize 실행파일 못 찾음: ${Q}`);
  info('환경변수 LLAMA_QUANTIZE=/path/quantize 설정 또는 llama.cpp 빌드');
}
if (CONV) {
  if (fs.existsSync(CONV)) ok(`convert_hf_to_gguf.py: ${CONV}`);
  else bad(`convert_hf_to_gguf.py 경로 불일치: ${CONV}`);
} else {
  warn_('LLAMA_CONVERT 미설정 — 양자화 시 convert 단계 생략됨');
  info('환경변수 LLAMA_CONVERT=/path/convert_hf_to_gguf.py 설정');
}

// ----- nvidia-smi -----
head('GPU / VRAM');
if (cmdExists('nvidia-smi')) {
  const name = runSafe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
  if (name) ok(`GPU: ${name}`); else warn_('nvidia-smi 응답 없음');
} else {
  warn_('nvidia-smi 없음 — VRAM 폴백(시스템 RAM 추정치) 사용');
}

// ----- 기본 모델 디렉토리 -----
head('로컬 모델 디렉토리');
const modelsDir = path.join(ROOT, 'backend', 'models');
const files = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir).filter((f) => !/^\./.test(f)) : [];
if (files.length) ok(`${modelsDir} — 모델 ${files.length}개: ${files.slice(0, 3).join(', ')}...`);
else warn_(`${modelsDir} — 모델 없음. 이곳에 .safetensors/.gguf/.bin 파일 또는 모델 폴더 배치`);

// ----- HuggingFace 토큰 -----
head('HuggingFace 토큰');
info('앱 내 토큰 입력창에서 write 권한 토큰 필요');
info('발급: https://huggingface.co/settings/tokens');

// ----- 결과 -----
console.log('');
if (err) console.log(`${c.err}${c.b}[FAIL]${c.r} 치명 오류 ${err}건 — 위 ★ 항목 먼저 해결`);
else if (warn) console.log(`${c.warn}${c.b}[WARN]${c.r} 권고 ${warn}건 — 실행은 가능하지만 일부 기능이 제한될 수 있음`);
else console.log(`${c.ok}${c.b}[PASS]${c.r} 모든 점검 통과 — npm start 로 실행 가능`);
process.exit(err ? 2 : (warn ? 1 : 0));
