#!/bin/zsh
cd "${0:A:h}" || exit 1
pause_if_interactive() {
  if [[ -t 0 ]]; then read -k 1 '?按任意键退出…'; fi
}
fail() {
  echo "安装或启动失败：$1"
  pause_if_interactive
  exit 1
}
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail "需要 Apple 芯片 Mac。"
if [[ ! -x .venv/bin/python || ! -f .cache/model/config.json || ! -x .venv-omnivoice/bin/python || ! -f .cache/omnivoice-official/config.json ]]; then
  command -v uv >/dev/null || {
    command -v brew >/dev/null || fail "首次安装需要 uv。请先安装 Homebrew 和 uv，再重新运行。"
    brew install uv || fail "无法安装 uv。"
  }
  [[ -x .venv/bin/python ]] || uv sync --frozen --no-install-project || fail "安装千问运行环境失败。"
  if [[ ! -f .cache/model/config.json ]]; then
    .venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit", local_dir=".cache/model")' || fail "下载千问模型失败。"
  fi
  if [[ ! -x .venv-omnivoice/bin/python ]]; then
    uv venv .venv-omnivoice --python 3.11 || fail "创建 OmniVoice 运行环境失败。"
    uv pip install --python .venv-omnivoice/bin/python 'torch==2.8.0' 'torchaudio==2.8.0' 'omnivoice==0.2.1' soundfile || fail "安装 OmniVoice 依赖失败。"
  fi
  if [[ ! -f .cache/omnivoice-official/config.json ]]; then
    .venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("k2-fsa/OmniVoice", local_dir=".cache/omnivoice-official")' || fail "下载 OmniVoice 模型失败。"
  fi
fi
label="com.shengke.voice-studio"
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents" data/logs
port=$(.venv/bin/python - <<'PY'
from pathlib import Path
import socket

path = Path('data/local-port')
try:
    saved = int(path.read_text().strip())
except (FileNotFoundError, ValueError):
    saved = None
if saved is None or not 1024 <= saved <= 65535:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        saved = sock.getsockname()[1]
    path.write_text(f'{saved}\n')
print(saved)
PY
) || fail "无法选择本机端口。"

.venv/bin/python - "$PWD" "$plist" "$port" <<'PY'
import plistlib
import sys
from pathlib import Path

root, destination, port = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
data = root / "data"
config = {
    "Label": "com.shengke.voice-studio",
    "ProgramArguments": [str(root / ".venv/bin/python"), "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", port],
    "WorkingDirectory": str(root),
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "StandardOutPath": str(data / "logs/server.log"),
    "StandardErrorPath": str(data / "logs/server-error.log"),
}
destination.write_bytes(plistlib.dumps(config))
PY

uid=$(id -u)
launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
sleep 1
if ! launchctl bootstrap "gui/$uid" "$plist"; then
  sleep 2
  launchctl bootstrap "gui/$uid" "$plist" || {
  echo "后台服务安装失败。请检查 data/logs/server-error.log。"
  pause_if_interactive
  exit 1
  }
fi

for _ in {1..30}; do
  if /usr/bin/curl -fsS "http://127.0.0.1:$port/api/status" >/dev/null 2>&1; then
    echo "声刻已在后台启动：http://127.0.0.1:$port"
    echo "服务会在 Codex 关闭后继续运行，并在你登录 Mac 时自动启动。"
    open "http://127.0.0.1:$port/"
    exit 0
  fi
  sleep 1
done

echo "声刻启动超时。音色和生成记录仍保存在 data/ 中；请查看 data/logs/server-error.log。"
pause_if_interactive
exit 1
