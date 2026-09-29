"""Local-only voice cloning studio for Apple Silicon."""

from __future__ import annotations

import asyncio
import atexit
import gc
import json
import re
import select
import subprocess
import threading
import uuid
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from scipy.io import wavfile


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
VOICES = DATA / "voices"
OUTPUTS = DATA / "outputs"
MODEL = ROOT / ".cache" / "model"
OMNI_MODEL = ROOT / ".cache" / "omnivoice-official"
OMNI_PYTHON = ROOT / ".venv-omnivoice" / "bin" / "python"
for directory in (VOICES, OUTPUTS):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="本地声音克隆")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
_model = None
_model_lock = threading.Lock()
_generation_lock = asyncio.Lock()
_omni_process: subprocess.Popen | None = None
_omni_log = None


def ffmpeg(*args: str) -> None:
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", *args]
    subprocess.run(command, check=True, capture_output=True, timeout=120)


def voice_dir(voice_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", voice_id):
        raise HTTPException(400, "音色编号无效")
    path = VOICES / voice_id
    if not (path / "profile.json").exists():
        raise HTTPException(404, "找不到这个音色")
    return path


def read_profile(path: Path) -> dict:
    return json.loads((path / "profile.json").read_text(encoding="utf-8"))


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            if not (MODEL / "config.json").exists():
                raise RuntimeError("模型尚未下载，请先执行安装说明中的模型下载命令")
            from mlx_audio.tts.utils import load_model

            _model = load_model(str(MODEL))
        return _model


def generate_qwen_wav(profile: dict, voice_id: str, text: str, temporary: Path) -> None:
    model = get_model()
    reference = VOICES / voice_id / "reference.wav"
    segments = []
    sample_rate = None
    for result in model.generate(
        text=text,
        lang_code="chinese",
        ref_audio=str(reference),
        ref_text=profile["transcript"],
        verbose=False,
    ):
        if result.audio is not None and result.audio.size:
            segments.append(np.asarray(result.audio).reshape(-1))
            sample_rate = result.sample_rate
    if not segments or sample_rate is None:
        raise RuntimeError("模型没有生成音频，请缩短文案或更换参考录音")
    audio = np.clip(np.concatenate(segments), -1, 1)
    wavfile.write(temporary, int(sample_rate), (audio * 32767).astype(np.int16))


def stop_omnivoice() -> None:
    global _omni_process, _omni_log
    if _omni_process is not None:
        if _omni_process.poll() is None:
            _omni_process.terminate()
            try:
                _omni_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _omni_process.kill()
                _omni_process.wait()
        for stream in (_omni_process.stdin, _omni_process.stdout):
            if stream:
                stream.close()
        _omni_process = None
    if _omni_log is not None:
        _omni_log.close()
        _omni_log = None


atexit.register(stop_omnivoice)


def release_qwen() -> None:
    global _model
    with _model_lock:
        if _model is not None:
            _model = None
            gc.collect()
            import mlx.core as mx

            mx.clear_cache()


def worker_response(timeout: int) -> dict:
    if _omni_process is None or _omni_process.stdout is None:
        raise RuntimeError("OmniVoice 进程没有启动")
    ready, _, _ = select.select([_omni_process.stdout], [], [], timeout)
    if not ready:
        raise RuntimeError("OmniVoice 等待超时，请重试")
    line = _omni_process.stdout.readline()
    if not line:
        raise RuntimeError("OmniVoice 进程已退出，请查看 .cache/omnivoice-worker.log")
    return json.loads(line)


def get_omnivoice_process() -> subprocess.Popen:
    global _omni_process, _omni_log
    if _omni_process is not None and _omni_process.poll() is None:
        return _omni_process
    stop_omnivoice()
    if not OMNI_PYTHON.exists() or not (OMNI_MODEL / "model.safetensors").exists():
        raise RuntimeError("OmniVoice 尚未安装完整")
    release_qwen()
    _omni_log = (ROOT / ".cache" / "omnivoice-worker.log").open("a", encoding="utf-8")
    _omni_process = subprocess.Popen(
        [str(OMNI_PYTHON), "-u", str(ROOT / "omnivoice_runner.py"), "--worker", "--model", str(OMNI_MODEL)],
        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=_omni_log,
        text=True, bufsize=1,
    )
    try:
        response = worker_response(180)
        if not response.get("ready"):
            raise RuntimeError("OmniVoice 启动失败")
    except Exception:
        stop_omnivoice()
        raise
    return _omni_process


def generate_omnivoice_wav(profile: dict, voice_id: str, text: str, temporary: Path) -> None:
    process = get_omnivoice_process()
    request = {"text": text, "ref_text": profile["transcript"],
               "reference": str(VOICES / voice_id / "reference.wav"), "output": str(temporary)}
    try:
        process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        process.stdin.flush()
        response = worker_response(360)
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "OmniVoice 生成失败"))
    except Exception:
        stop_omnivoice()
        raise


def generate_mp3(profile: dict, voice_id: str, text: str, output: Path, engine: str) -> None:
    temporary = output.with_suffix(".wav")
    try:
        if engine == "omnivoice":
            generate_omnivoice_wav(profile, voice_id, text, temporary)
        else:
            stop_omnivoice()
            generate_qwen_wav(profile, voice_id, text, temporary)
        ffmpeg("-y", "-i", str(temporary), "-codec:a", "libmp3lame", "-b:a", "192k", str(output))
        ffmpeg("-i", str(output), "-f", "null", "-")
    finally:
        temporary.unlink(missing_ok=True)


@app.get("/")
def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/status")
def status():
    qwen_ready = (MODEL / "config.json").exists()
    omni_ready = OMNI_PYTHON.exists() and (OMNI_MODEL / "model.safetensors").exists()
    return {"model_downloaded": qwen_ready, "model_loaded": _model is not None, "busy": _generation_lock.locked(),
            "engines": [{"id": "qwen", "name": "千问 3 TTS", "available": qwen_ready},
                        {"id": "omnivoice", "name": "OmniVoice", "available": omni_ready}]}


@app.get("/api/voices")
def voices():
    profiles = [read_profile(path) for path in VOICES.iterdir() if (path / "profile.json").exists()]
    return sorted(profiles, key=lambda item: item["created_at"], reverse=True)


@app.post("/api/voices")
async def add_voice(name: str = Form(...), transcript: str = Form(...), audio: UploadFile = File(...)):
    name, transcript = name.strip(), transcript.strip()
    if not 1 <= len(name) <= 40 or not 2 <= len(transcript) <= 500:
        raise HTTPException(400, "请填写音色名称和录音中实际说出的文字")
    if audio.content_type and not (audio.content_type.startswith(("audio/", "video/")) or audio.content_type == "application/octet-stream"):
        raise HTTPException(400, "请上传音频或视频文件")
    raw = await audio.read(25 * 1024 * 1024 + 1)
    if len(raw) > 25 * 1024 * 1024 or not raw:
        raise HTTPException(400, "音频应小于 25 MB")
    voice_id = uuid.uuid4().hex
    directory = VOICES / voice_id
    directory.mkdir()
    source = directory / "upload"
    source.write_bytes(raw)
    try:
        ffmpeg("-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "24000", "-t", "15", str(directory / "reference.wav"))
        rate, signal = wavfile.read(directory / "reference.wav")
        duration = len(signal) / rate
        if duration < 3:
            raise HTTPException(400, "录音至少需要 3 秒")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "文件里没有可读取的声音，请重新录音，或换用 MP4、MOV、WAV、MP3、M4A、WebM") from exc
    finally:
        source.unlink(missing_ok=True)
    from datetime import datetime, timezone

    profile = {"id": voice_id, "name": name, "transcript": transcript, "duration": round(duration, 1), "created_at": datetime.now(timezone.utc).isoformat()}
    (directory / "profile.json").write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    return profile


@app.delete("/api/voices/{voice_id}")
def delete_voice(voice_id: str):
    directory = voice_dir(voice_id)
    for path in directory.iterdir():
        path.unlink()
    directory.rmdir()
    return {"ok": True}


@app.get("/api/voices/{voice_id}/reference")
def reference(voice_id: str):
    return FileResponse(voice_dir(voice_id) / "reference.wav", media_type="audio/wav")


@app.post("/api/generate")
async def generate(voice_id: str = Form(...), text: str = Form(...), engine: str = Form("qwen")):
    profile = read_profile(voice_dir(voice_id))
    text = text.strip()
    if not 1 <= len(text) <= 500:
        raise HTTPException(400, "单次请输入 1～500 字中文文案")
    if engine not in ("qwen", "omnivoice"):
        raise HTTPException(400, "请选择有效的声音模型")
    if engine == "omnivoice" and not (OMNI_PYTHON.exists() and (OMNI_MODEL / "model.safetensors").exists()):
        raise HTTPException(400, "OmniVoice 尚未安装完整")
    if _generation_lock.locked():
        raise HTTPException(409, "正在生成另一段音频，请稍后再试")
    async with _generation_lock:
        output_id = uuid.uuid4().hex
        output = OUTPUTS / f"{output_id}.mp3"
        try:
            await asyncio.to_thread(generate_mp3, profile, voice_id, text, output, engine)
        except Exception as exc:
            output.unlink(missing_ok=True)
            raise HTTPException(500, f"生成失败：{exc}") from exc
    result = {"id": output_id, "url": f"/api/outputs/{output_id}", "filename": f"{profile['name']}-{output_id[:8]}.mp3", "voice_id": voice_id, "voice_name": profile["name"], "text": text, "engine": engine, "verified": True}
    output.with_suffix(".json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


@app.get("/api/latest")
def latest_output():
    metadata = sorted(OUTPUTS.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in metadata:
        if path.with_suffix(".mp3").exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return None


@app.get("/api/outputs")
def list_outputs():
    records = []
    for path in OUTPUTS.glob("*.json"):
        if path.with_suffix(".mp3").exists():
            record = json.loads(path.read_text(encoding="utf-8"))
            record["created_at"] = path.stat().st_mtime
            records.append(record)
    recorded_ids = {record["id"] for record in records}
    for audio in OUTPUTS.glob("*.mp3"):
        if audio.stem in recorded_ids:
            continue
        records.append({
            "id": audio.stem,
            "url": f"/api/outputs/{audio.stem}",
            "filename": audio.name,
            "voice_id": None,
            "voice_name": "找回的音频",
            "text": "这条 MP3 文件仍在本机，但原文和模型信息缺失。",
            "engine": "unknown",
            "verified": False,
            "created_at": audio.stat().st_mtime,
        })
    return sorted(records, key=lambda item: item["created_at"], reverse=True)


@app.get("/api/outputs/{output_id}")
def output_audio(output_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", output_id):
        raise HTTPException(400, "文件编号无效")
    path = OUTPUTS / f"{output_id}.mp3"
    if not path.exists():
        raise HTTPException(404, "找不到音频文件")
    return FileResponse(path, media_type="audio/mpeg", filename=path.name, content_disposition_type="inline")


@app.delete("/api/outputs/{output_id}")
def delete_output(output_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", output_id):
        raise HTTPException(400, "文件编号无效")
    audio = OUTPUTS / f"{output_id}.mp3"
    metadata = OUTPUTS / f"{output_id}.json"
    if not audio.exists() and not metadata.exists():
        raise HTTPException(404, "找不到这条生成记录")
    audio.unlink(missing_ok=True)
    metadata.unlink(missing_ok=True)
    return {"ok": True}
