# ⚡ LLM Fusion Studio

> LLM 모델 병합(merge) → GGUF 양자화(quantize) → HuggingFace 업로드를
> 마우스 몇 번으로 끝내는 데스크톱 앱. Qwen 계열 우선 지원.

CLI에 의존하던 mergekit / llama.cpp / huggingface_hub 작업을 하나의 직관적인
GUI로 통합해, 로컬 LLM 튜닝 초보자도 모델 퓨전을 시도할 수 있게 만든다.

---

## ✨ 주요 기능

- **3단 Flexbox 다크 UI** — Model Library / Merge Canvas / Status & Terminal
- **드래그 앤 드롭 병합** — 로컬 베이스 모델을 캔버스에 끌어다 놓고 슬라이더로 비율 조절
- **GGUF 양자화** — Q4_K_M / Q5_K_M / Q6_K / Q8_0 / F16 선택
- **HuggingFace 직접 Push** — 결과물을 지정 레포지토리에 업로드 (private 기본)
- **VRAM 게이지** — GPU 총 VRAM 자동 감지, 80% 경고 / 100% 붉은 경고
- **실시간 터미널 로그** — Python 백엔드의 stdout을 스트리밍 출력
- **초보자 온보딩** — 환영 오버레이 + ? 도움말 풍선 + 용어 툴팁 + 단계 번호 가이드
- **실행 전 확인 다이얼로그** — 병합 요약 + 경고 후 실행

---

## 🧱 기술 스택

| 레이어 | 기술 |
|---|---|
| 프론트엔드 | 순수 HTML / CSS (Flexbox) / JavaScript (렌더러) |
| 데스크톱 | Electron (Node.js 메인 프로세스 + IPC) |
| 백엔드 | Python (`mergekit`, `llama.cpp quantize`, `huggingface_hub`) |
| VRAM | `nvidia-smi` 우선 → `systeminformation` 폴백 |

---

## 📁 디렉토리 구조

```
llm-fusion-studio/
├─ electron/
│  ├─ main.js          # Electron 메인: Python spawn + VRAM 모니터 + 설정 파일
│  └─ preload.js       # contextBridge IPC (window.eapi)
├─ backend/
│  ├─ fusion_server.py # Python 브릿지: mergekit → GGUF 변환 → HF 업로드
│  ├─ requirements.txt
│  └─ models/          # 로컬 베이스 모델을 넣는 기본 폴더
└─ src/
   ├─ index.html        # 3단 Flexbox 레이아웃
   ├─ css/style.css     # 다크모드 테마
   └─ js/main.js        # 렌더러: 드래그앤드롭, 슬라이더, 게이지, 온보딩
```

---

## 🚀 빠른 시작

### 1) Node 의존성
```bash
npm install
```

### 2) Python 의존성
```bash
cd backend
pip install -r requirements.txt
```

### 3) llama.cpp 빌드 (양자화용)
`quantize` 실행파일과 `convert_hf_to_gguf.py`가 필요합니다.
환경변수로 경로 지정하거나 실행 시 인자로 넘깁니다:

```bash
export LLAMA_QUANTIZE=/path/to/llama.cpp/build/bin/quantize
export LLAMA_CONVERT=/path/to/llama.cpp/convert_hf_to_gguf.py
```

### 4) 실행
```bash
npm start          # 프로덕션 모드
npm run dev        # DevTools 함께
```

### 5) 빌드 (Windows 설치파일)
```bash
npm run build:win
```

---

## 🔧 실행 안 될 때 진단

```bash
npm run doctor
```

아래 항목을 점검합니다:

- Node / Electron 설치 여부
- Python 인터프리터 경로
- `backend/requirements.txt` 패키지 (`mergekit`, `huggingface_hub`, `torch`)
- `quantize` 실행파일 / `convert_hf_to_gguf.py` 경로
- `nvidia-smi` 존재 여부 (VRAM 자동 감지용)
- HuggingFace 토큰(write 권한) 권장

---

## 🖼️ 스크린샷 (포트폴리오용)

아래 경로에 캡처를 넣으면 README에 표시됩니다:

```
docs/img/01-welcome.png   # 환영/모드 선택 화면
docs/img/02-canvas.png    # 모델 드래그앤드롭 + 슬라이더
docs/img/03-quant.png     # GGUF 드롭다운 + 확인 다이얼로그
docs/img/04-terminal.png   # VRAM 게이지 + 실시간 로그
```

캡처 예시 (앱 실행 후):

![Welcome](docs/img/01-welcome.png)

---

## 🗂️ 작업 파이프라인

```
[좌측: 모델 선택]
        │ 드래그
        ▼
[중앙: 캔버스 + 슬라이더 + 양자화 옵션 + 저장소명]
        │ [Merge & Push] → 확인 다이얼로그
        ▼
[Python: mergekit-yaml → convert_hf_to_gguf.py → quantize → huggingface_hub]
        │ stdout 라인 스트리밍
        ▼
[우측: VRAM 게이지 + 실시간 터미널 로그]
```

---

## ⚠️ 주의

- 병합/양자화는 **GPU 메모리를 많이 씁니다**. VRAM 게이지가 빨간색이면 작업을 멈추세요.
- HuggingFace 토큰은 **write 권한**이 있어야 업로드됩니다.
- `mergekit-yaml`과 `llama.cpp quantize`는 별도 설치/빌드가 필요합니다.

---

## 📜 라이선스

MIT
