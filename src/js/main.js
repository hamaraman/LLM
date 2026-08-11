// 렌더러 로직 — Electron preload가 노출한 window.eapi를 통해서만 백엔드와 통신

const $ = (id) => document.getElementById(id);

const state = {
  modelsDir: '',      // 로컬 모델 디렉토리
  stack: [],          // 병합 캔버스에 올린 모델들 [{name, path}]
  running: false,
};

const confirmDialog = $('confirm-dialog');

// ---------- 토스트 ----------
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add('hidden'), 2500);
}
function setStatus(kind, label) {
  const b = $('app-status');
  b.className = `status-badge ${kind}`;
  b.textContent = label;
}

// ---------- 터미널 ----------
function logLine(text, cls = '') {
  const term = $('terminal');
  const span = document.createElement('div');
  span.className = cls;
  span.textContent = text;
  term.appendChild(span);
  term.scrollTop = term.scrollHeight;
}

// ---------- VRAM 게이지 ----------
let VRAM_LIMIT_MB = 8192; // 기본값: RTX 3070 Ti (8GB), GPU 정보 수신 시 자동 갱신
function setVramLimit(mb) {
  VRAM_LIMIT_MB = mb || VRAM_LIMIT_MB;
  document.querySelectorAll('.vram-limit-text').forEach((el) => el.textContent = `기준: ${Math.round(VRAM_LIMIT_MB / 1024)} GB`);
}
function updateVram(usedMB) {
  const pct = Math.min(100, (usedMB / VRAM_LIMIT_MB) * 100);
  const fill = $('vram-fill');
  fill.style.width = pct + '%';
  fill.className = 'vram-fill';
  if (pct >= 100) fill.classList.add('alert');
  else if (pct >= 80) fill.classList.add('warn');
  $('vram-text').textContent = `${Math.round(usedMB)} / ${Math.round(VRAM_LIMIT_MB)} MB`;
}

// ---------- 모델 리스트 ----------
async function refreshModels() {
  const list = $('model-list');
  list.innerHTML = '<li class="muted">스캔 중…</li>';
  try {
    const models = await window.eapi.scanModels(state.modelsDir);
    if (!models.length) {
      list.innerHTML = '<li class="muted">모델이 없습니다</li>';
      return;
    }
    list.innerHTML = '';
    models.forEach((m) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.textContent = m.name;
      li.dataset.path = m.path;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(m));
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = `<li class="muted">오류: ${e.message}</li>`;
  }
}

// ---------- 슬라이더 ----------
function renderSliders() {
  const wrap = $('sliders');
  wrap.innerHTML = '';
  if (!state.stack.length) {
    wrap.innerHTML = '<p class="muted small">모델을 캔버스에 올리면 비율 슬라이더가 나타납니다.</p>';
    return;
  }
  // 기본 비율: 균등 분할
  state.stack.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'slider-item';
    div.innerHTML = `
      <div class="label"><span>${item.name} <span class="term" data-term="slider">비율</span></span><span class="pct" data-i="${i}">--</span></div>
      <input type="range" min="0" max="100" value="${Math.round(100 / state.stack.length)}" data-i="${i}" />
    `;
    wrap.appendChild(div);
  });
  updateSliderLabels();
  attachTermTooltips();
}

function updateSliderLabels() {
  const inputs = document.querySelectorAll('#sliders input[type=range]');
  const vals = Array.from(inputs).map((i) => Number(i.value));
  const sum = vals.reduce((a, b) => a + b, 0) || 1;
  inputs.forEach((inp, i) => {
    const pct = ((vals[i] / sum) * 100).toFixed(1);
    document.querySelector(`.pct[data-i="${i}"]`).textContent = pct + '%';
  });
}

// ---------- 드래그앤드롭 ----------
const zone = $('dropzone');
zone.addEventListener('dragover', (e) => {
  e.preventDefault();
  zone.classList.add('dragover');
});
zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  zone.classList.remove('dragover');
  try {
    const m = JSON.parse(e.dataTransfer.getData('text/plain'));
    if (state.stack.find((x) => x.path === m.path)) {
      toast('이미 올린 모델입니다', 'err');
      return;
    }
    state.stack.push(m);
    renderStack();
    renderSliders();
    updateMergeButton();
  } catch (err) {
    toast('드롭 실패: ' + err.message, 'err');
  }
});

function renderStack() {
  const ul = $('merge-stack');
  ul.innerHTML = '';
  state.stack.forEach((item, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${item.name}</span><button data-i="${i}" title="제거">✕</button>`;
    li.querySelector('button').addEventListener('click', () => {
      state.stack.splice(i, 1);
      renderStack();
      renderSliders();
      updateMergeButton();
    });
    ul.appendChild(li);
  });
}

function updateMergeButton() {
  const ok = state.stack.length >= 2 && $('repo-name').value.trim() && $('hf-token').value.trim();
  $('btn-merge').disabled = !ok;
}

// ---------- 이벤트 ----------
$('btn-pick-dir').addEventListener('click', async () => {
  const dir = await window.eapi.pickModelDir();
  if (dir) {
    state.modelsDir = dir;
    $('model-dir').value = dir;
    refreshModels();
  }
});

// 병합 payload 빌더
function buildMergePayload() {
  const inputs = document.querySelectorAll('#sliders input[type=range]');
  const ratios = Array.from(inputs).map((i) => Number(i.value));
  const sum = ratios.reduce((a, b) => a + b, 0) || 1;
  return {
    models: state.stack.map((m, i) => ({ name: m.name, path: m.path, ratio: ratios[i] / sum })),
    quant: $('quant').value,
    repo: $('repo-name').value.trim(),
    hfToken: $('hf-token').value.trim(),
    modelsDir: state.modelsDir,
  };
}

// 실제 병합 실행 (확인 다이얼로그 "실행하기" 눌렀을 때)
async function runMergeReal(payload) {
  state.running = true;
  $('btn-merge').disabled = true;
  $('btn-cancel').disabled = false;
  setStatus('running', 'RUNNING');
  logLine('▶ Merge & Push 시작…');
  try {
    await window.eapi.startMerge(payload);
    logLine('✓ 완료', 'line-ok');
    toast('완료!', 'ok');
  } catch (e) {
    logLine('✗ 오류: ' + e.message, 'line-err');
    toast('실패', 'err');
  } finally {
    state.running = false;
    $('btn-cancel').disabled = true;
    updateMergeButton();
    setStatus('idle', 'IDLE');
  }
}

// btn-merge: 확인 다이얼로그 띄우기
$('btn-merge').addEventListener('click', () => {
  if (state.running) return;
  const payload = buildMergePayload();
  $('confirm-summary').innerHTML = showConfirmSummary(payload);
  confirmDialog.classList.remove('hidden');
});

// 확인 다이얼로그 실행 버튼
$('confirm-ok').addEventListener('click', async () => {
  const payload = buildMergePayload();
  confirmDialog.classList.add('hidden');
  await runMergeReal(payload);
});

$('btn-cancel').addEventListener('click', () => window.eapi.cancelMerge());

document.querySelectorAll('#repo-name, #hf-token').forEach((el) =>
  el.addEventListener('input', updateMergeButton)
);

// 슬라이더 값 변화
$('sliders').addEventListener('input', (e) => {
  if (e.target.matches('input[type=range]')) updateSliderLabels();
});

// ---------- 백엔드 → 렌더러 스트림 (preload가 노출) ----------
window.eapi.onLog((line, cls) => logLine(line, cls || ''));
window.eapi.onVram((usedMB) => updateVram(usedMB));
window.eapi.onVramLimit && window.eapi.onVramLimit((totalMB) => setVramLimit(totalMB));
window.eapi.onGpuName && window.eapi.onGpuName((name) => {
  $('gpu-name').textContent = 'GPU: ' + name;
});

// ---------- 부팅 ----------
window.eapi.getDefaultModelsDir().then((dir) => {
  state.modelsDir = dir;
  $('model-dir').value = dir;
  refreshModels();
});
logLine('LLM Fusion Studio ready.');

// ============ 온보딩 / 도움말 ============

// 도움말 텍스트 (data-help 키별)
const HELP_TEXT = {
  library: {
    title: 'Model Library (①재료 고르기)',
    body: '합칠 AI 모델들이 있는 폴더입니다. <b>HuggingFace 토큰</b>은 결과물을 업로드할 때 필요한 "열쇠"예요. 모델 목록은 자동으로 스캔되며, <b>Qwen</b> 계열이 위에 표시돼요.',
    tip: '처음엔 backend/models 폴더에 모델 파일(.safetensors 등)을 넣어두면 됩니다.',
  },
  merge: {
    title: 'Merge Canvas (②비율 정하기)',
    body: '왼쪽에서 모델을 끌어다 놓고, 각 모델이 결과에 얼마나 영향을 줄지 <b>슬라이더</b>로 정합니다. <b>양자화(GGUF)</b>는 모델 크기를 줄이는 작업, <b>저장소 이름</b>은 업로드될 주소(예: 내아이디/모델이름)예요.',
    tip: '비율 합이 100%가 안 되어도 자동으로 정규화됩니다.',
  },
  status: {
    title: 'Status & Terminal (③진행 상황)',
    body: '<b>VRAM</b>은 그래픽 카드 메모리 사용량. 작업이 무거우면 빨간색으로 바뀌며 위험 경고. 아래 <b>터미널</b>은 백그라운드에서 돌아가는 작업 로그가 실시간으로 표시돼요.',
    tip: 'RTX 3070 Ti(8GB) 기준. 작업 전 다른 무거운 앱은 끄는 게 안전해요.',
  },
  quant:     '양자화: 4비트/5비트 등으로 모델을 압축하는 작업. <b>Q4_K_M</b>이 크기/성능 균형이 좋아 추천.',
  repo:      'HuggingFace 저장소 주소. 형식: <b>아이디/모델이름</b> (예: teriro/my-fusion-v1). 이미 있으면 그곳에, 없으면 새로 만들어집니다.',
  hftoken:   'HuggingFace API 토큰. <b>write 권한</b>이 있어야 업로드 가능. Settings → Access Tokens에서 발급.',
  dropzone:  '여기에 모델을 끌어다 놓으세요. <b>최소 2개</b>를 올려야 병합할 수 있어요.',
  slider:    '각 모델의 <b>비율</b>. 높을수록 그 모델의 특성이 결과에 더 강하게 반영돼요.',
};

// 풍선 표시
const bubble = $('bubble');
let bubbleTimer = null;
function showBubble(target, key) {
  const data = HELP_TEXT[key];
  if (!data) return;
  const rect = target.getBoundingClientRect();
  bubble.innerHTML = data.title
    ? `<b>${data.title}</b><br>${data.body}${data.tip ? '<div class=\"tip\">💡 ' + data.tip + '</div>' : ''}`
    : data;
  bubble.classList.remove('hidden');
  // 위치: 타겟 오른쪽 아래, 화면 밖이면 왼쪽으로
  let left = rect.left + rect.width + 8;
  let top = rect.top;
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
  if (left + 270 > window.innerWidth) bubble.style.left = (rect.left - 270) + 'px';
  if (top + 100 > window.innerHeight) bubble.style.top = (window.innerHeight - 120) + 'px';
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, 6000);
}
function hideBubble() { bubble.classList.add('hidden'); }

// ? 버튼
document.querySelectorAll('.help-btn').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (bubble.dataset.open === b.dataset.help) { hideBubble(); bubble.dataset.open = ''; return; }
    bubble.dataset.open = b.dataset.help;
    showBubble(b, b.dataset.help);
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.help-btn') && !e.target.closest('#bubble')) hideBubble();
});

// 용어 tooltip (HTML 안의 .term 요소에 자동 적용)
function attachTermTooltips() {
  document.querySelectorAll('.term').forEach((t) => {
    const key = t.dataset.term;
    if (!t._bound) {
      t.addEventListener('mouseenter', () => showBubble(t, key));
      t.addEventListener('mouseleave', hideBubble);
      t._bound = true;
    }
  });
}

// 환영 오버레이
const DONT_SHOW_KEY = 'llmfs_dont_show_welcome';
const MODE_KEY = 'llmfs_mode';
let __settings = null;
async function loadSettingsAsync() {
  if (__settings !== null) return __settings;
  try { __settings = await window.eapi.getSettings(); } catch (e) { __settings = {}; }
  if (!__settings) __settings = {};
  return __settings;
}
async function saveSettingsAsync(patch) {
  const cur = await loadSettingsAsync();
  __settings = Object.assign({}, cur, patch);
  try { await window.eapi.saveSettings(__settings); } catch (e) {}
  return __settings;
}
function shouldShowWelcome() {
  return !__settings || __settings.dontShowWelcome !== true;
}
function setMode(mode) {
  document.body.classList.toggle('beginner', mode === 'beginner');
  saveSettingsAsync({ mode });
  if (mode === 'beginner') {
    toast('초보자 모드 — 각 패널 번호(①②③)를 따라 진행하세요', 'ok');
  } else {
    toast('전문가 모드', 'ok');
  }
}
function showWelcome() {
  const w = $('welcome');
  if (!shouldShowWelcome()) { return; }
  w.classList.remove('hidden');
}
$('welcome-beginner').addEventListener('click', () => {
  $('welcome').classList.add('hidden');
  setMode('beginner');
});
$('welcome-expert').addEventListener('click', () => {
  $('welcome').classList.add('hidden');
  setMode('expert');
});
document.getElementById('welcome-dont-show').addEventListener('change', (e) => {
  saveSettingsAsync({ dontShowWelcome: e.target.checked });
});

// 부팅 시 (설정 파일 비동기 로드)
(async function bootOnboarding() {
  const st = await loadSettingsAsync();
  const mode = st.mode || 'expert';
  document.body.classList.toggle('beginner', mode === 'beginner');
  // welcome: dontShowWelcome 면 숨김, 아니면 showWelcome
  if (st.dontShowWelcome === true) {
    $('welcome').classList.add('hidden');
  } else {
    showWelcome();
  }
  attachTermTooltips();
})();


// ============ 병합 실행 전 확인 다이얼로그 ============
$('confirm-cancel').addEventListener('click', () => confirmDialog.classList.add('hidden'));

// btn-merge 기존 클릭 핸들러 앞에 확인 다이얼로그 끼워넣기: 기존 핸들러를 runMergeReal 로 이동
function showConfirmSummary(payload) {
  const modelNames = payload.models.map((m) => m.name).join(', ');
  const totalRatio = payload.models.reduce((a, m) => a + m.ratio, 0);
  const ratioStr = payload.models.map((m) => `${m.name} ${(m.ratio/totalRatio*100).toFixed(0)}%`).join(' · ');
  return `models        : <b>${modelNames}</b>
비 율        : ${ratioStr}
양자화       : <b>${payload.quant}</b>
업로드 저장소 : <b>${payload.repo}</b>`;
}
