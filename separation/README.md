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
