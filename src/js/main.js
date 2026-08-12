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

// ---------- 프로그레스 ----------
function updateProgress(step, total, label) {
  const block = $('pipeline-progress');
  if (!block) return;
  block.classList.remove('hidden');
  const pct = Math.round((step / total) * 100);
  $('progress-fill').style.width = pct + '%';
  $('progress-label').textContent = label;
  $('progress-step').textContent = `${step}/${total}`;
}
function resetProgress() {
  const block = $('pipeline-progress');
  if (!block) return;
  block.classList.add('hidden');
  $('progress-fill').style.width = '0%';
  $('progress-label').textContent = '대기 중';
  $('progress-step').textContent = '0/4';
}

// ---------- 완료 결과 카드 ----------
let mergeStartTime = 0;
function showResultCard(payload) {
  const card = $('result-card');
  const body = $('result-body');
  if (!card || !body) return;
  const elapsed = mergeStartTime ? Math.round((Date.now() - mergeStartTime) / 1000) : 0;
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const timeStr = min > 0 ? `${min}분 ${sec}초` : `${sec}초`;
  body.innerHTML =
    `├── 양자화: <b>${payload.quant.toUpperCase()}</b><br>` +
    `├── 모델: <b>${payload.models.map(m => m.name).join(' + ')}</b><br>` +
    (payload.repo ? `├── HuggingFace: <b><a href="https://huggingface.co/${payload.repo}" target="_blank" style="color:var(--accent)">${payload.repo}</a></b><br>` : '') +
    `└── 소요 시간: <b>${timeStr}</b>`;
  card.classList.remove('hidden');
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
// 자동 감지 우선: 시스템의 모든 표준 모델 보관소(HF 캐시, Ollama, LM Studio, 앱 폴더 등)를
// 스캔해서 하나의 리스트로 합침. 사용자가 수동으로 폴더를 고르지 않아도 됨.
// state.autoscan=true면 scanAll API 사용, false면 scanModels(state.modelsDir) 사용.
state.autoscan = true;

// 출처	source 코드 → 화면 표시 라벨/클래스
const SOURCE_LABEL = {
  app:      { text: '앱',     cls: 'src-app' },
  hf:       { text: 'HF',     cls: 'src-hf' },
  ollama:   { text: 'Ollama', cls: 'src-ollama' },
  lmstudio: { text: 'LM',     cls: 'src-lmstudio' },
  gpt4all:  { text: 'GPT4All', cls: 'src-gpt4all' },
  custom:   { text: '사용자',  cls: 'src-custom' },
};

async function refreshModels() {
  const list = $('model-list');
  list.innerHTML = '<li class="muted">로컬 모델 자동 감지 중…</li>';
  try {
    let models = [];
    if (state.autoscan) {
      // 모든 표준 보관소를 스캔해 합침
      const groups = await window.eapi.scanAll();
      // 비어있지 않은 그룹만 모아서, 출처(source) 정보와 함께 평탄화
      const flat = [];
      groups.forEach((g) => g.models.forEach((m) => flat.push({
        name: m.name, path: m.path, source: m.source, sourceLabel: SOURCE_LABEL[m.source] || { text: '?', cls: '' },
      })));
      models = flat;
    } else {
      models = (await window.eapi.scanModels(state.modelsDir)).map((m) => ({
        ...m, source: 'custom', sourceLabel: SOURCE_LABEL.custom,
      }));
    }
    if (!models.length) {
      list.innerHTML = state.autoscan
        ? '<li class="muted">📂 모델이 아직 없습니다.<br><br>' +
          '<b>모델 다운로드 방법:</b><br>' +
          '1. <a href="https://huggingface.co/models" target="_blank" style="color:var(--accent)">HuggingFace</a>에서 모델 다운로드<br>' +
          '2. backend/models/ 폴더에 넣기<br><br>' +
          '<button id="btn-pick-fallback" class="btn sm">📁 폴더 직접 선택</button></li>'
        : '<li class="muted">이 폴더에 모델이 없습니다.<br>모델 파일(.safetensors, .gguf 등)이 있는 폴더를 선택하세요.</li>';
      const fb = $('btn-pick-fallback');
      if (fb) fb.addEventListener('click', () => $('btn-pick-dir').click());
      return;
    }
    list.innerHTML = '';
    models.forEach((m) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.title = m.path;
      const badge = m.sourceLabel
        ? `<span class="src-badge ${m.sourceLabel.cls}">${m.sourceLabel.text}</span> `
        : '';
      li.innerHTML = `${badge}<span class="model-name">${escapeHtml(m.name)}</span>`;
      li.dataset.path = m.path;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(m));
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dblclick', () => {
        if (state.stack.find((x) => x.path === m.path)) {
          toast('이미 올린 모델입니다', 'err'); return;
        }
        state.stack.push(m);
        renderStack(); renderSliders(); updateMergeButton();
        toast(m.name + ' 추가됨', 'ok');
      });
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = `<li class="muted">오류: ${escapeHtml(e.message)}</li>`;
  }
}

// 모델명/경로에 HTML 특수문자가 있을 때 이스케이프 (XSS 방지)
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
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
  // 드롭존 힌트 숨기기/표시
  const hints = zone.querySelectorAll('.drop-main-hint, .drop-sub-hint');
  hints.forEach(h => h.style.display = state.stack.length ? 'none' : '');
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
  const repo = $('repo-name').value.trim();
  const token = $('hf-token').value.trim();
  const repoValid = !repo || /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(repo);
  const ok = state.stack.length >= 2 && repo && token && repoValid;
  $('repo-name').style.borderColor = (repo && !repoValid) ? 'var(--danger)' : '';
  $('btn-merge').disabled = !ok;
  // 비활성 사유 표시
  const hint = $('merge-hint');
  if (hint) {
    if (state.stack.length < 2) hint.textContent = '⚠ 모델을 2개 이상 추가하세요';
    else if (!repo) hint.textContent = '⚠ 저장소 이름을 입력하세요 (예: user/model-name)';
    else if (!repoValid) hint.textContent = '⚠ 형식: 아이디/모델이름 (예: teriro/my-fusion-v1)';
    else if (!token) hint.textContent = '⚠ HuggingFace 토큰을 입력하세요';
    else hint.textContent = '';
  }
}

// ---------- 이벤트 ----------
$('btn-pick-dir').addEventListener('click', async () => {
  const dir = await window.eapi.pickModelDir();
  if (dir) {
    state.modelsDir = dir;
    state.autoscan = false;   // 수동 선택 시 자동 감지 끄고, 해당 폴더만 스캔
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
  mergeStartTime = Date.now();
  resetProgress(); $('pipeline-progress') && $('pipeline-progress').classList.remove('hidden');
  try {
    await window.eapi.startMerge(payload);
    logLine('✓ 완료', 'line-ok');
    toast('완료!', 'ok');
    showResultCard(payload);
  } catch (e) {
    logLine('✗ 오류: ' + e.message, 'line-err');
    toast('실패', 'err');
  } finally {
    state.running = false;
    $('btn-cancel').disabled = true;
    updateMergeButton();
    setStatus('idle', 'IDLE');
    resetProgress();
  }
}

// btn-merge: 확인 다이얼로그 띄우기
$('btn-merge').addEventListener('click', () => {
  if (state.running) return;
  // VRAM 경고
  const vramFill = $('vram-fill');
  if (vramFill) {
    const vramPct = parseFloat(vramFill.style.width) || 0;
    if (vramPct >= 80) {
      if (!confirm('⚠️ VRAM 사용량이 약 ' + Math.round(vramPct) + '%입니다.\n작업이 실패하거나 매우 느려질 수 있습니다.\n계속하시겠습니까?')) return;
    }
  }
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

// ---------- 용어 사전 ----------
$('btn-glossary').addEventListener('click', () => {
  $('glossary').classList.toggle('hidden');
});
$('glossary-close').addEventListener('click', () => {
  $('glossary').classList.add('hidden');
});

$('result-dismiss') && $('result-dismiss').addEventListener('click', () => {
  $('result-card').classList.add('hidden');
});

// ---------- 양자화 예상 정보 ----------
const QUANT_INFO = {
  q4_k_m: '💡 Q4_K_M: 7B 모델 기준 약 10~20분, 파일 약 4GB',
  q5_k_m: '💡 Q5_K_M: 7B 모델 기준 약 15~25분, 파일 약 5GB',
  q6_k:   '💡 Q6_K: 7B 모델 기준 약 15~25분, 파일 약 5.5GB',
  q8_0:   '💡 Q8_0: 7B 모델 기준 약 20~30분, 파일 약 7GB',
  f16:    '💡 F16: 양자화 없음, 7B 모델 기준 파일 약 14GB, VRAM 16GB+ 권장',
};
$('quant').addEventListener('change', () => {
  const info = $('quant-info');
  if (info) info.textContent = QUANT_INFO[$('quant').value] || '';
});

document.querySelectorAll('#repo-name, #hf-token').forEach((el) =>
  el.addEventListener('input', updateMergeButton)
);

$('hf-token').addEventListener('blur', () => {
  const val = $('hf-token').value.trim();
  if (val && !val.startsWith('hf_')) {
    toast('HF 토큰은 보통 hf_로 시작합니다. 확인해 주세요.', 'err');
  }
});

// 슬라이더 값 변화
$('sliders').addEventListener('input', (e) => {
  if (e.target.matches('input[type=range]')) updateSliderLabels();
});

// ---------- 백엔드 → 렌더러 스트림 (preload가 노출) ----------
window.eapi.onLog((line, cls) => {
  logLine(line, cls || '');
  // 파이프라인 진행률 감지
  if (line.includes('[merge]') || line.includes('mergekit'))  updateProgress(1, 4, 'mergekit 병합 중…');
  if (line.includes('[convert_gguf]') || line.includes('HF → GGUF')) updateProgress(2, 4, 'GGUF 변환 중…');
  if (line.includes('[quantize_') || line.includes('양자화'))  updateProgress(3, 4, '양자화 중…');
  if (line.includes('업로드'))   updateProgress(4, 4, 'HF 업로드 중…');
});
window.eapi.onVram((usedMB) => updateVram(usedMB));
window.eapi.onVramLimit && window.eapi.onVramLimit((totalMB) => setVramLimit(totalMB));
window.eapi.onGpuName && window.eapi.onGpuName((name) => {
  $('gpu-name').textContent = 'GPU: ' + name;
});

// ---------- 작업 중 창 닫기 방지 ----------
window.addEventListener('beforeunload', (e) => {
  if (state.running) {
    e.preventDefault();
    e.returnValue = '병합 작업이 진행 중입니다. 정말 종료하시겠습니까?';
  }
});

// ---------- 부팅 ----------
// 자동 감지 모드(기본): 시스템의 모든 표준 보관소를 스캔.
// state.modelsDir 기본값은 설정(저장된 커스텀 폴더)에서 가져오고, 없으면 앱 기본 폴더.
window.eapi.getDefaultModelsDir().then((dir) => {
  state.modelsDir = dir;
  $('model-dir').value = dir;
  // 설정에 저장된 모델 폴더가 있으면 수동 모드로 시작, 없으면 자동 감지
  window.eapi.getSettings().then((st) => {
    if (st && st.modelsDir) {
      state.modelsDir = st.modelsDir;
      state.autoscan = false;
      $('model-dir').value = st.modelsDir;
    } else {
      // 자동 감지 — 입력란은 안내 텍스트로 표시
      $('model-dir').value = '자동 감지 (HF · Ollama · 앱 폴더)';
      state.autoscan = true;
    }
    // 마지막으로 저장된 설정이 있으면 그 폴더로 재개 (autoload)
    loadSettingsAsync().then(() => refreshModels());
  });
}).catch(() => refreshModels());
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
  vram:      '<b>VRAM</b>은 그래픽 카드(RAM 대신 GPU)의 작업용 메모리. 모델이 클수록 많이 쓰고, 용량을 넘기면 작업이 멈추거나 매우 느려져요.',
};

// 풍선 표시
const bubble = $('bubble');
let bubbleTimer = null;
function showBubble(target, keyOrData) {
  const data = (typeof keyOrData === 'object' && keyOrData !== null && keyOrData.body) ? keyOrData : HELP_TEXT[keyOrData];
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
    startBeginnerGuide();
  } else {
    toast('전문가 모드', 'ok');
  }
}

// 초보자 모드 인터랙티브 가이드
let guideStep = 0;
const GUIDE_STEPS = [
  { el: '.panel.left',    msg: '① 왼쪽 패널에서 병합할 모델을 확인하세요.\n모델이 없으면 "변경" 버튼으로 폴더를 지정하세요.' },
  { el: '#dropzone',      msg: '② 모델을 이곳으로 드래그하세요.\n(또는 더블클릭으로 추가)\n최소 2개가 필요합니다.' },
  { el: '#quant',         msg: '③ 양자화 옵션을 고르세요.\nQ4_K_M이 크기/성능 균형이 가장 좋습니다.' },
  { el: '#btn-merge',     msg: '④ 모든 준비가 끝나면 이 버튼을 누르세요!\n실행 전 확인 다이얼로그가 뜹니다.' },
];
function startBeginnerGuide() {
  guideStep = 0;
  showGuideStep();
}
function showGuideStep() {
  if (guideStep >= GUIDE_STEPS.length) { hideBubble(); return; }
  const s = GUIDE_STEPS[guideStep];
  const el = document.querySelector(s.el);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showBubble(el, { title: `단계 ${guideStep + 1}/${GUIDE_STEPS.length}`, body: s.msg.replace(/\n/g, '<br>'), tip: '아무 곳이나 클릭하면 다음 단계로 넘어갑니다.' });
    // 가이드 중에는 클릭 시 다음 단계로
    const handler = (e) => {
      if (e.target.closest('#bubble')) return;
      document.removeEventListener('click', handler, true);
      guideStep++;
      setTimeout(showGuideStep, 300);
    };
    setTimeout(() => document.addEventListener('click', handler, true), 200);
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
  const quantLabel = {
    q4_k_m: 'Q4_K_M (4비트, 가장 많이 사용)',
    q5_k_m: 'Q5_K_M (5비트, 좋은 품질)',
    q6_k:   'Q6_K (6비트, 고품질)',
    q8_0:   'Q8_0 (8비트, 거의 원본)',
    f16:    'F16 (무손실, 매우 큰 파일)',
  };
  return `<b>📋 병합 요약</b><br><br>` +
    `🤖 모델: <b>${modelNames}</b><br>` +
    `⚖️ 비율: ${ratioStr}<br>` +
    `📦 양자화: <b>${quantLabel[payload.quant] || payload.quant}</b><br>` +
    `📤 업로드: <b>${payload.repo || '(없음 — 업로드 안 함)'}</b>`;
}
