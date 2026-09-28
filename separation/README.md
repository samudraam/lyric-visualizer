# Vocal / instrumental separation (Demucs)

Splits a song into **vocals** and **instrumental**, or into every stem, using [Demucs v4](https://github.com/adefossez/demucs), a pretrained neural network. It runs locally, on your Mac's GPU where available.

## Setup (once)

```bash
cd separation
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # ~1 GB, mostly PyTorch
```

The first separation also downloads the model weights (about 80 MB per model) from Hugging Face. They're cached after that.

## Use

```bash
cd separation
.venv/bin/python separate.py ~/Music/song.mp3
# → separated/htdemucs/song/vocals.wav, instrumental.wav
```

| Option | What it does |
|---|---|
| `--stems all` | Also saves `drums`, `bass` and `other` (plus `guitar` and `piano` with `htdemucs_6s`) |
| `--model htdemucs_ft` | Best quality, about 4× slower. `--list-models` shows all of them |
| `--format mp3` | Saves MP3 (or `flac`) instead of WAV |
| `--shifts 5` | Averages 5 slightly shifted passes: a little cleaner, 5× slower |
| `--device cpu` | Forces the CPU. Default is `auto`: NVIDIA GPU, then Mac GPU, then CPU |
| `--out DIR` | Output folder (default `separated/`) |

Several files at once: `.venv/bin/python separate.py *.mp3`. Any format ffmpeg can read works as input.

**Speed on an M1 Pro (Mac GPU):** about 12× realtime with `htdemucs`; a 3 min 21 s song took 17 s. Very short clips run slower per second of audio, because loading the model dominates.

**Common mistake:** it's `.venv/bin/python` (with a dot), run on its own line after `cd separation`.

## Tested

A 12 s test mix (a spoken voice from macOS `say` over synthesized chords and noise), scored against the known originals with SDR (signal-to-distortion ratio; higher is better):

| Stem | Demucs output | Returning the mix unchanged |
|---|---|---|
| Vocals | 20.4 dB | 5.0 dB |
| Instrumental | 15.3 dB | −5.0 dB |

Real songs are harder. Demucs v4 averages about 9 dB on vocals on the MUSDB18 benchmark.

## How it works

1. The audio is decoded and resampled to 44.1 kHz stereo.
2. It's cut into overlapping chunks of about 8 s, so a whole song never has to fit in memory.
3. The network predicts one waveform per stem for each chunk. It learned this from songs where every instrument was recorded separately.
4. The chunks are cross-faded back together.
5. The instrumental is the sum of every non-vocal stem.

A good next step for learning is the path in the main discussion: train [Open-Unmix](https://github.com/sigsep/open-unmix-pytorch) on MUSDB18 to see how a separation model learns.

## Cloud: Split vocals from the app

In the editor, sign in, load a song with **Upload audio**, and click **Split vocals**. The song is separated on Google Cloud, and the stems load into the mixer dials automatically.

```
Browser ── upload ──► Storage  users/{uid}/separations/{id}/input.mp3
        ── create ──► Firestore users/{uid}/separations/{id}  (status: queued)
                           │ triggers
                           ▼
                      Function startSeparation (functions/index.js)
                           │ runs, with this song's details
                           ▼
                      Cloud Run Job separate-stems (worker.py, us-east1, CPU)
                           ├─► Storage  …/{id}/vocals.mp3, instrumental.mp3
                           └─► Firestore status: running (progress) → ready | error
Browser ◄── watches the doc, downloads both stems, loads them into the mixer
```

| Piece | Where | Notes |
|---|---|---|
| `worker.py` + `Dockerfile` | Cloud Run Job `separate-stems`, `us-east1` | 4 vCPU, 8 GiB, 30 min limit, no retries. CPU-only PyTorch; model weights built into the image |
| `startSeparation` | `functions/index.js` | Checks the upload path belongs to the user, allows at most 3 separations in progress per user, starts the job, returns straight away |
| `src/lib/cloudSeparations.js`, `useCloudSeparation.js` | Browser | Upload with progress, watch status, download stems |
| `storage.rules` | Storage | Each user can only read and write `users/{uid}/**`; 50 MB upload limit |
| `storage.cors.json` | Bucket CORS setting | Lets the app's addresses download stems in the browser |

### Deploy

```bash
# the job (Cloud Build builds the Dockerfile; takes ~5-10 min)
gcloud run jobs deploy separate-stems --source separation --region us-east1 --project lyric-bloom \
  --cpu 4 --memory 8Gi --task-timeout 30m --max-retries 0 \
  --set-env-vars STORAGE_BUCKET=lyric-bloom.firebasestorage.app,FIRESTORE_DATABASE=lyricbloom,DEMUCS_MODEL=htdemucs

# the function + Storage rules
firebase deploy --only functions,storage

# bucket CORS (once, or when the app's addresses change)
gcloud storage buckets update gs://lyric-bloom.firebasestorage.app --cors-file=storage.cors.json
```

### Watching and debugging

```bash
gcloud run jobs executions list --job separate-stems --region us-east1 --project lyric-bloom
gcloud beta run jobs executions logs read <execution-name> --region us-east1 --project lyric-bloom
```

Each run's Firestore doc also records `processingSeconds`, `durationSeconds` and, on failure, `error`.

### Cost

You pay only while a job runs: about $0.0001 per second for 4 vCPU and 8 GiB, so roughly **1–2¢ per 3-minute song**. Nothing runs, and nothing is billed, while idle. Uploaded songs and stems stay in Storage; add a lifecycle rule to delete them after N days if storage adds up.
