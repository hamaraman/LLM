# -*- coding: utf-8 -*-
"""llm-fusion-studio: patch main.js (renderer)
- localStorage 기반 → Electron 설정 파일(eapi.getSettings/saveSettings) 기반으로 교체
- 병합 실행 전 확인 다이얼로그 로직 추가
"""
import io

P = 'src/js/main.js'
with io.open(P, encoding='utf-8') as f:
    s = f.read()

# 1) shouldShowWelcome 교체 → 설정 파일 로드 함수 추가
OLD1 = '''function shouldShowWelcome() {
  // Electron 환경에서는 localStorage 대신 설정 파일. 지금은 localStorage 시도.
  try { return localStorage.getItem(DONT_SHOW_KEY) !== '1'; }
  catch (e) { return true; }
}'''
NEW1 = '''let __settings = null;
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
}'''
assert OLD1 in s, 'OLD1 not found'
s = s.replace(OLD1, NEW1)

# 2) setMode: localStorage → saveSettings
OLD2 = '''function setMode(mode) {
  document.body.classList.toggle('beginner', mode === 'beginner');
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
  if (mode === 'beginner') {
    toast('초보자 모드 — 각 패널 번호(①②③)를 따라 진행하세요', 'ok');
  } else {
    toast('전문가 모드', 'ok');
  }
}'''
NEW2 = '''function setMode(mode) {
  document.body.classList.toggle('beginner', mode === 'beginner');
  saveSettingsAsync({ mode });
  if (mode === 'beginner') {
    toast('초보자 모드 — 각 패널 번호(①②③)를 따라 진행하세요', 'ok');
  } else {
    toast('전문가 모드', 'ok');
  }
}'''
assert OLD2 in s, 'OLD2 not found'
s = s.replace(OLD2, NEW2)

# 3) don't-show 체크박스 → saveSettings
OLD3 = '''$('welcome-dont-show') && $('welcome-dont-show').addEventListener('change', (e) => {
  try { localStorage.setItem(DONT_SHOW_KEY, e.target.checked ? '1' : '0'); } catch (er) {}
});'''
NEW3 = '''document.getElementById('welcome-dont-show').addEventListener('change', (e) => {
  saveSettingsAsync({ dontShowWelcome: e.target.checked });
});'''
assert OLD3 in s, 'OLD3 not found'
s = s.replace(OLD3, NEW3)

# 4) bootOnboarding → 비동기 + 설정 로드
OLD4 = '''// 부팅 시
(function bootOnboarding() {
  let mode = 'expert';
  try { mode = localStorage.getItem(MODE_KEY) || 'expert'; } catch (e) {}
  document.body.classList.toggle('beginner', mode === 'beginner');
  showWelcome();
  attachTermTooltips();
})();'''
NEW4 = '''// 부팅 시 (설정 파일 비동기 로드)
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
})();'''
assert OLD4 in s, 'OLD4 not found'
s = s.replace(OLD4, NEW4)

# 5) 병합 실행 전 확인 다이얼로그 로직 추가 (파일 끝)
APPEND = '''

// ============ 병합 실행 전 확인 다이얼로그 ============
const confirmDialog = $('confirm-dialog');
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
'''
s += APPEND

with io.open(P, 'w', encoding='utf-8') as f:
    f.write(s)
print('patched')
