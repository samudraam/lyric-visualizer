"""Split songs into vocals and instrumental (or all stems) with Demucs.

    python separate.py song.mp3                      # vocals.wav + instrumental.wav
    python separate.py song.mp3 --stems all          # + drums/bass/other (and guitar/piano with htdemucs_6s)
    python separate.py *.mp3 --model htdemucs_ft     # better quality, ~4x slower

Output: separated/<model>/<song name>/<stem>.wav

How it works (see README.md for more): Demucs is a neural network trained on
songs where every instrument was recorded separately. Given a mixed song it
predicts one waveform per source ("stem"): drums, bass, other, vocals. Long
songs are cut into overlapping ~8 s chunks so they fit in memory, separated
chunk by chunk, and cross-faded back together.
"""
import argparse
import os
import sys
import time
from pathlib import Path

# Let PyTorch run any operation the Mac GPU (MPS) doesn't support yet on the
# CPU instead of failing. Must be set before torch is imported.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import torch  # noqa: E402
from demucs.api import Separator, save_audio  # noqa: E402

MODELS = {
    "htdemucs": "Hybrid Transformer Demucs v4, 4 stems. Good default.",
    "htdemucs_ft": "htdemucs fine-tuned per stem. Best quality, ~4x slower.",
    "htdemucs_6s": "6 stems: adds guitar and piano (piano is weak).",
    "mdx_extra": "Older MDX challenge model, 4 stems.",
}


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"  # NVIDIA GPU
    if torch.backends.mps.is_available():
        return "mps"  # Apple Silicon GPU
    return "cpu"


def audio_seconds(wav: torch.Tensor, samplerate: int) -> float:
    return wav.shape[-1] / samplerate


def separate_file(separator: Separator, path: Path, out_root: Path, all_stems: bool, fmt: str) -> None:
    started = time.perf_counter()
    # `mix` is the input resampled to the model's rate (44.1 kHz stereo);
    # `stems` maps a source name to a tensor shaped (channels, samples).
    mix, stems = separator.separate_audio_file(path)
    elapsed = time.perf_counter() - started

    out_dir = out_root / path.stem
    out_dir.mkdir(parents=True, exist_ok=True)

    # The instrumental is every non-vocal stem summed back together. Because
    # the model is trained so its stems add up to the mix, this is close to
    # (mix - vocals) but avoids any phase leftovers from subtracting.
    outputs = {
        "vocals": stems["vocals"],
        "instrumental": sum(wav for name, wav in stems.items() if name != "vocals"),
    }
    if all_stems:
        outputs.update({name: wav for name, wav in stems.items() if name != "vocals"})

    for name, wav in outputs.items():
        # save_audio rescales if a stem would clip, so peaks don't distort.
        save_audio(wav.cpu(), out_dir / f"{name}.{fmt}", samplerate=separator.samplerate)

    duration = audio_seconds(mix, separator.samplerate)
    print(
        f"  {path.name}: {duration:.0f}s of audio in {elapsed:.1f}s "
        f"({duration / elapsed:.1f}x realtime) -> {out_dir}/"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", type=Path, help="audio files (anything ffmpeg can read)")
    parser.add_argument("--model", default="htdemucs", choices=sorted(MODELS),
                        help="pretrained model (default: htdemucs)")
    parser.add_argument("--stems", choices=["two", "all"], default="two",
                        help="two = vocals + instrumental (default); all = also every individual stem")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"])
    parser.add_argument("--out", type=Path, default=Path("separated"), help="output folder (default: separated/)")
    parser.add_argument("--format", default="wav", choices=["wav", "mp3", "flac"])
    parser.add_argument("--shifts", type=int, default=1,
                        help="average N time-shifted passes; slower, slightly cleaner (default: 1)")
    parser.add_argument("--list-models", action="store_true", help="describe the models and exit")
    args = parser.parse_args()

    if args.list_models:
        for name, about in MODELS.items():
            print(f"  {name:12} {about}")
        return 0

    missing = [p for p in args.inputs if not p.is_file()]
    if missing:
        parser.error(f"file not found: {', '.join(map(str, missing))}")

    device = pick_device(args.device)
    print(f"Loading {args.model} on {device} (first run downloads the weights, ~80 MB per model)...")
    separator = Separator(model=args.model, device=device, shifts=args.shifts, progress=True)
    print(f"Stems this model predicts: {', '.join(separator.model.sources)}")

    out_root = args.out / args.model
    failed = 0
    for path in args.inputs:
        try:
            separate_file(separator, path, out_root, args.stems == "all", args.format)
        except Exception as err:  # keep going with the other files
            failed += 1
            print(f"  {path.name}: failed: {err}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
