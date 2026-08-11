// 렌더러 로직 — Electron preload가 노출한 window.eapi를 통해서만 백엔드와 통신

const $ = (id) => document.getElementById(id);

const state = {
  modelsDir: '',      // 로컬 모델 디렉토리
  stack: [],          // 병합 캔버스에 올린 모델들 [{name, path}]
  running: false,
};

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
const VRAM_LIMIT_MB = 8192; // RTX 3070 Ti = 8GB
function updateVram(usedMB) {
  const pct = Math.min(100, (usedMB / VRAM_LIMIT_MB) * 100);
  const fill = $('vram-fill');
  fill.style.width = pct + '%';
  fill.className = 'vram-fill';
  if (pct >= 100) fill.classList.add('alert');
  else if (pct >= 80) fill.classList.add('warn');
  $('vram-text').textContent = `${Math.round(usedMB)} / ${VRAM_LIMIT_MB} MB`;
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
      <div class="label"><span>${item.name}</span><span class="pct" data-i="${i}">--</span></div>
      <input type="range" min="0" max="100" value="${Math.round(100 / state.stack.length)}" data-i="${i}" />
    `;
    wrap.appendChild(div);
  });
  updateSliderLabels();
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

$('btn-merge').addEventListener('click', async () => {
  if (state.running) return;
  const inputs = document.querySelectorAll('#sliders input[type=range]');
  const ratios = Array.from(inputs).map((i) => Number(i.value));
  const sum = ratios.reduce((a, b) => a + b, 0) || 1;
  const payload = {
    models: state.stack.map((m, i) => ({ name: m.name, path: m.path, ratio: ratios[i] / sum })),
    quant: $('quant').value,
    repo: $('repo-name').value.trim(),
    hfToken: $('hf-token').value.trim(),
    modelsDir: state.modelsDir,
  };
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
