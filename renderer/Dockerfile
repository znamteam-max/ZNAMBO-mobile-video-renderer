FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pillow

WORKDIR /app
COPY renderer/server.py /app/server.py

ENV PORT=8080
EXPOSE 8080
CMD ["python3", "/app/server.py"]
