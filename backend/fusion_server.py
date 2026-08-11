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


def run_quantize(q, base_model_path, out_basename):
    """base_dir 내 pytorch_model.bin/safetensors 를 GGUF로 변환.
    llama.cpp 의 quantize 바이너리는 GGUF 입력을 받으므로,
    실제 프로덕션에선 convert_hf_to_gguf.py 를 먼저 거쳐야 한다.
    여기서는 인터페이스만 제공한다."""
    out_log("GGUF 변환 단계 (llama.cpp convert) — 인터페이스만 구현됨")
    # NOTE: 실제 환경에서는 아래 순서로 호출:
    #   python convert_hf_to_gguf.py <merged_dir> --outtype f16 --outfile <merged>.gguf
    #   <quantize_bin> <merged>.gguf <out>.gguf <quant_type>
    # 현재는 스킵하고 더미 경로 반환 (TODO)
    return None


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
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True, help="JSON payload (Sync)")
    ap.add_argument("--quantize-bin", default="quantize")
    args = ap.parse_args()

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

    # 3) 양자화 (있으면)
    quant = payload.get("quant", "f16")
    gguf_path = merged_dir / "model.gguf"
    if quant and quant != "f16":
        run_quantize(quant, merged_dir, "model")

    # 4) 업로드 (파일 존재 시)
    repo = payload.get("repo")
    token = payload.get("hfToken")
    upload_target = gguf_path if gguf_path.exists() else merged_dir
    if repo and token:
        if upload_target.is_dir():
            try:
                from huggingface_hub import HfApi, create_repo
                api = HfApi(token=token)
                create_repo(repo, token=token, exist_ok=True, repo_type="model", private=True)
                api.upload_folder(folder_path=str(upload_target), repo_id=repo, token=token)
                out_log(f"폴더 업로드 완료 → {repo}")
            except Exception as e:
                out_error(f"폴더 업로드 실패: {e}")
        else:
            push_to_hub(upload_target, repo, token)
    else:
        out_log("HF 토큰/레포 없음 — 업로드 스킵")

    # 정리
    shutil.rmtree(work, ignore_errors=True)
    out_done()


if __name__ == "__main__":
    main()
