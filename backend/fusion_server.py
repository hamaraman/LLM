"""
LLM Fusion Studio — Python backend bridge
Electron(electron/main.js)가 이 스크립트를 spawn 하여 stdin/stdout 라인 프로토콜로 통신한다.

실행:
    python fusion_server.py --json '<JSON>' --quantize-bin /path/quantize

stdout 라인 프로토콜 (Electron이 파싱):
    VRAM<TAB>사용량MB      (옵션)
    LOG<TAB>메시지          (일반 로그)
    DONE                     (전체 완료)
    ERROR<TAB>메시지        (오류)

파이프라인:
    1) JSON 파싱
    2) mergekit 설정 YAML 생성
    3) mergekit-yaml 서브프로세스 실행 (stdout 스트리밍)
    4) 출력 모델 → llama.cpp quantize 로 GGUF 변환 (선택 옵션)
    5) huggingface_hub 로 지정 레포에 업로드
"""
import os
import sys
import json
import argparse
import subprocess
import tempfile
import shutil
from pathlib import Path

# ---- 출력 헬퍼 (모든 출력은 \n 으로 끝나야 함) ----
def out_log(msg):    print(f"LOG\t{msg}", flush=True)
def out_vram(mb):    print(f"VRAM\t{mb}", flush=True)
def out_done():      print("DONE", flush=True)
def out_error(msg):
    print(f"ERROR\t{msg}", flush=True)
    sys.exit(1)


# ---- mergekit YAML 빌더 ----
def build_merge_yaml(payload):
    """payload['models'] = [{name, path, ratio}] → mergekit YAML string"""
    models = payload["models"]
    lines = [
        "merge_method: linear",
        "dtype: float16",
        "parameters:",
        "  t:",
    ]
    # mergekit linear: 마지막 모델이 base 역할, 가중치 합은 1에 가까울수록 좋음
    for i, m in enumerate(models):
        lines.append(f"    - value: {float(m['ratio']):.3f}")
        lines.append(f"      filter: null")
    lines.append("models:")
    for m in models[:-1]:
        lines.append(f"  - model: {m['path']}")
    # 마지막은 base 로 표기
    last = models[-1]
    lines.append(f"  - model: {last['path']}")
    return "\n".join(lines) + "\n"


# ---- 파이프라인 단계 ----
def run_mergekit(yaml_path, out_dir):
    out_log(f"mergekit-yaml 실행: {yaml_path}")
    cmd = ["mergekit-yaml", str(yaml_path), str(out_dir), "--copy-tokenizer", "--lazy-unpickle", "--allow-crimes"]
    return _stream_subprocess(cmd, step="merge")


# llama.cpp 변환스크립트/quantize 실행파일 경로 (명령행에서 --quantize-bin 으로 받음)
QUANTIZE_BIN = "quantize"
CONVERT_SCRIPT = ""  # 예: /path/to/llama.cpp/convert_hf_to_gguf.py


def run_quantize(q, merged_dir, out_basename, out_dir):
    """두 단계 양자화 파이프라인:
      (1) convert_hf_to_gguf.py  — HuggingFace 체크포인트(mergekit 출력) → f16 GGUF
      (2) <quantize_bin>          — f16 GGUF → 요청한 양자화(Q4_K_M 등) GGUF
    인자:
      q            : 양자화 타입 (예: q4_k_m / q5_k_m / f16)
      merged_dir   : mergekit 가 출력한 HF 포맷 모델 디렉토리 (config.json 등 있음)
      out_basename : 결과 GGUF 파일의 기본 이름
      out_dir      : 결과 GGUF 파일을 저장할 디렉토리
    리턴: 최종 GGUF 파일의 절대경로 (실패 시 None)
    """
    # 1단계: HF → f16 GGUF
    f16_gguf = os.path.join(str(out_dir), f"{out_basename}.f16.gguf")
    if not CONVERT_SCRIPT:
        out_error("convert_hf_to_gguf.py 경로가 설정되지 않음 --quantize-bin 또는 환경변수 LLAMA_CONVERT 확인")
    if os.path.exists(f16_gguf):
        out_log(f"1단계 스킵(이미 존재): {f16_gguf}")
    else:
        cmd1 = ["python", str(CONVERT_SCRIPT), str(merged_dir), "--outtype", "f16", "--outfile", f16_gguf]
        try:
            _stream_subprocess(cmd1, step="convert_gguf")
        except SystemExit:
            return None

    # 2단계: f16 GGUF → 요청한 양자화 타입
    quant_gguf = os.path.join(str(out_dir), f"{out_basename}.{q}.gguf")
    if q == "f16":
        out_log("양자화 타입=f16 → 2단계 건너뜀, f16 GGUF를 결과로 사용")
        return f16_gguf
    cmd2 = [QUANTIZE_BIN, f16_gguf, quant_gguf, q]
    try:
        _stream_subprocess(cmd2, step=f"quantize_{q}")
    except SystemExit:
        return None
    return quant_gguf


def push_to_hub(file_path, repo_id, token):
    out_log(f"HuggingFace 업로드: {repo_id}")
    try:
        from huggingface_hub import HfApi, create_repo
        api = HfApi(token=token)
        create_repo(repo_id, token=token, exist_ok=True, repo_type="model", private=True)
        api.upload_file(path_or_fileobj=str(file_path), path_in_repo=os.path.basename(file_path), repo_id=repo_id, token=token)
        out_log(f"업로드 완료 → {repo_id}/{os.path.basename(file_path)}")
    except Exception as e:
        out_error(f"HF 업로드 실패: {e}")


# ---- subprocess 스트리머 ----
def _stream_subprocess(cmd, step="step"):
    out_log(f"$ {' '.join(str(c) for c in cmd)}")
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except FileNotFoundError:
        out_error(f"실행파일을 못 찾음: {cmd[0]} (mergekit/llama.cpp 설치 확인)")
    for line in iter(proc.stdout.readline, ""):
        out_log(f"[{step}] {line.rstrip()}")
    rc = proc.wait()
    if rc != 0:
        out_error(f"{step} 실패 (exit {rc})")
    return rc


# ---- 메인 ----
def main():
    global QUANTIZE_BIN, CONVERT_SCRIPT
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True, help="JSON payload (Sync)")
    ap.add_argument("--quantize-bin", default=os.environ.get("LLAMA_QUANTIZE", "quantize"),
                    help="llama.cpp quantize 실행파일 경로")
    ap.add_argument("--convert-script", default=os.environ.get("LLAMA_CONVERT", ""),
                    help="llama.cpp convert_hf_to_gguf.py 경로")
    args = ap.parse_args()
    QUANTIZE_BIN = args.quantize_bin
    CONVERT_SCRIPT = args.convert_script

    try:
        payload = json.loads(args.json)
    except Exception as e:
        out_error(f"JSON 파싱 실패: {e}")

    out_log("▶ LLM Fusion Studio 파이프라인 시작")
    out_log(f"  모델: {[m['name'] for m in payload['models']]}")
    out_log(f"  양자화: {payload.get('quant', 'none')}")
    out_log(f"  업로드 레포: {payload.get('repo')}")

    work = Path(tempfile.mkdtemp(prefix="fusion_"))
    merged_dir = work / "merged"
    merged_dir.mkdir(parents=True, exist_ok=True)

    # 1) mergekit YAML
    yaml_text = build_merge_yaml(payload)
    yaml_path = work / "merge.yaml"
    yaml_path.write_text(yaml_text, encoding="utf-8")
    out_log("생성된 merge.yaml:\n" + yaml_text)

    # 2) 실행
    try:
        run_mergekit(yaml_path, merged_dir)
    except SystemExit:
        raise
    except Exception as e:
        out_error(f"mergekit 오류: {e}")

    # 3) 양자화 (있으면) — HF 포맷 mergekit 출력을 GGUF로 변환
    quant = payload.get("quant", "f16")
    gguf_dir = work / "gguf"
    gguf_dir.mkdir(parents=True, exist_ok=True)
    final_target = None  # 업로드 대상(파일 또는 디렉토리)
    if quant:
        base_name = "model"
        try:
            final_target = run_quantize(quant, merged_dir, base_name, gguf_dir)
        except SystemExit:
            raise
        except Exception as e:
            out_error(f"양자화 오류: {e}")
    # convert 스크립트 없거나 양자화 안 함 → HF 디렉토리 그대로 업로드 폴백
    if not final_target:
        out_log("GGUF 변환 스킵 — mergekit HF 출력 디렉토리를 그대로 업로드")
        final_target = merged_dir

    # 4) 업로드 (파일 또는 디렉토리)
    repo = payload.get("repo")
    token = payload.get("hfToken")
    if repo and token:
        if isinstance(final_target, (str, os.PathLike)) and os.path.isdir(str(final_target)):
            try:
                from huggingface_hub import HfApi, create_repo
                api = HfApi(token=token)
                create_repo(repo, token=token, exist_ok=True, repo_type="model", private=True)
                api.upload_folder(folder_path=str(final_target), repo_id=repo, token=token)
                out_log(f"폴더 업로드 완료 → {repo}")
            except Exception as e:
                out_error(f"폴더 업로드 실패: {e}")
        elif final_target:
            push_to_hub(final_target, repo, token)
    else:
        out_log("HF 토큰/레포 없음 — 업로드 스킵")

    # 정리
    shutil.rmtree(work, ignore_errors=True)
    out_done()


if __name__ == "__main__":
    main()
