"""Run the official OmniVoice model in its isolated Python environment."""

from __future__ import annotations

import argparse
import json
import sys
import traceback

import numpy as np
import soundfile as sf
import torch
from omnivoice import OmniVoice


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--reference")
    parser.add_argument("--output")
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    model = OmniVoice.from_pretrained(args.model, device_map="mps", dtype=torch.float16)
    if args.worker:
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            try:
                request = json.loads(line)
                generate(model, request, request["reference"], request["output"])
                print(json.dumps({"ok": True}), flush=True)
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                print(json.dumps({"error": str(exc)}, ensure_ascii=False), flush=True)
    else:
        if not args.reference or not args.output:
            parser.error("--reference and --output are required outside worker mode")
        generate(model, json.load(sys.stdin), args.reference, args.output)


def generate(model: OmniVoice, request: dict, reference: str, output: str) -> None:
    audio = model.generate(text=request["text"], ref_audio=reference, ref_text=request["ref_text"])
    if not audio or not np.asarray(audio[0]).size:
        raise RuntimeError("OmniVoice 没有生成声音")
    sf.write(output, np.asarray(audio[0]).reshape(-1), 24000)


if __name__ == "__main__":
    main()
