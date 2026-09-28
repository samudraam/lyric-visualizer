# Cloud Run Job image for worker.py: Demucs on CPU.
FROM python:3.12-slim

# ffmpeg: Demucs's fallback decoder for formats sphn can't read (m4a, aac…).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch first, from PyTorch's own index: ~200 MB instead of the
# ~2.5 GB default wheel that bundles CUDA libraries this job can't use.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements-worker.txt .
RUN pip install --no-cache-dir -r requirements-worker.txt

# Bake the model weights into the image so a job doesn't download ~80 MB
# from Hugging Face every time it starts.
ENV HF_HOME=/models
ARG DEMUCS_MODEL=htdemucs
RUN python -c "from demucs.pretrained import get_model; get_model('${DEMUCS_MODEL}')"

COPY separate.py worker.py ./
CMD ["python", "worker.py"]
