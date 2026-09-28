"""Cloud Run Job: separate one uploaded song into vocals + instrumental.

Started by the startSeparation Cloud Function (functions/index.js) with
these environment variables for the one song to process:

    SEPARATION_UID     owner's Firebase uid
    SEPARATION_ID      id of users/{uid}/separations/{id} in Firestore
    INPUT_PATH         Storage path of the uploaded song

and, set once on the job itself:

    STORAGE_BUCKET     e.g. lyric-bloom.firebasestorage.app
    FIRESTORE_DATABASE e.g. lyricbloom
    DEMUCS_MODEL       default htdemucs

It downloads the song, runs Demucs (see separate.py), uploads
vocals.mp3 + instrumental.mp3 next to the input, and keeps the Firestore
doc's `status` / `progress` current so the browser can show progress:

    running (progress 0..1) -> ready (vocalsPath, instrumentalPath)
                            -> error (error message)
"""
import os
import sys
import tempfile
import time
from pathlib import Path

import torch
from demucs.api import Separator, save_audio
from google.cloud import firestore, storage

from separate import audio_seconds, mix_outputs

# Write progress to Firestore at most this often; every write costs a
# little and the browser only needs a rough percentage.
PROGRESS_EVERY_SECONDS = 3


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if not value:
        sys.exit(f"Missing environment variable {name}")
    return value


def main() -> int:
    uid = env("SEPARATION_UID")
    separation_id = env("SEPARATION_ID")
    input_path = env("INPUT_PATH")
    bucket_name = env("STORAGE_BUCKET")
    model = env("DEMUCS_MODEL", "htdemucs")

    # Defence in depth: the function already checks this, but never let a
    # job read or write outside the owner's own separation folder.
    folder = f"users/{uid}/separations/{separation_id}/"
    if not input_path.startswith(folder):
        sys.exit(f"INPUT_PATH {input_path!r} is outside {folder!r}")

    db = firestore.Client(database=env("FIRESTORE_DATABASE"))
    doc = db.document(f"users/{uid}/separations/{separation_id}")
    bucket = storage.Client().bucket(bucket_name)

    started = time.perf_counter()
    doc.update({"status": "running", "progress": 0, "model": model})

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            local_input = tmp / Path(input_path).name
            bucket.blob(input_path).download_to_filename(local_input)
            print(f"Downloaded {input_path} ({local_input.stat().st_size / 1e6:.1f} MB)")

            # Demucs calls this at the start and end of every chunk. Chunks
            # overlap and a model can be a bag of several sub-models, so
            # progress = chunks finished / total, across all sub-models.
            last_write = 0.0

            def on_progress(info: dict) -> None:
                nonlocal last_write
                if info["state"] != "end" or time.monotonic() - last_write < PROGRESS_EVERY_SECONDS:
                    return
                per_model = (info["segment_offset"] + 1) / info["audio_length"]
                done = (info["model_idx_in_bag"] + min(per_model, 1)) / info["models"]
                doc.update({"progress": round(done, 3)})
                last_write = time.monotonic()

            separator = Separator(model=model, device="cpu", callback=on_progress)
            print(f"Loaded {model} ({torch.get_num_threads()} CPU threads)")
            mix, stems = separator.separate_audio_file(local_input)

            paths = {}
            for name, wav in mix_outputs(stems, all_stems=False).items():
                local_out = tmp / f"{name}.mp3"
                save_audio(wav, local_out, samplerate=separator.samplerate)
                paths[name] = f"{folder}{name}.mp3"
                blob = bucket.blob(paths[name])
                blob.upload_from_filename(local_out, content_type="audio/mpeg")
                print(f"Uploaded {paths[name]} ({local_out.stat().st_size / 1e6:.1f} MB)")

        duration = audio_seconds(mix, separator.samplerate)
        elapsed = time.perf_counter() - started
        doc.update({
            "status": "ready",
            "progress": 1,
            "vocalsPath": paths["vocals"],
            "instrumentalPath": paths["instrumental"],
            "durationSeconds": round(duration, 2),
            "processingSeconds": round(elapsed, 1),
            "finishedAt": firestore.SERVER_TIMESTAMP,
        })
        print(f"Done: {duration:.0f}s of audio in {elapsed:.0f}s ({duration / elapsed:.2f}x realtime)")
        return 0
    except Exception as err:
        print(f"Separation failed: {err}", file=sys.stderr)
        doc.update({"status": "error", "error": str(err)[:500]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
