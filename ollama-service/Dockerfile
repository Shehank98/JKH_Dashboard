# Ollama for the dashboard's slide notes. Deploy this folder as its own service (Railway: Root Directory = /ollama-service).
FROM ollama/ollama:latest

# Models to download on first start (space separated). They are kept on the /root/.ollama volume, so later starts are instant.
ENV PRELOAD_MODELS="llama3.2:3b qwen2.5:3b" \
    OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_KEEP_ALIVE=30m \
    OLLAMA_MAX_LOADED_MODELS=1 \
    OLLAMA_NUM_PARALLEL=1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 11434
VOLUME /root/.ollama
ENTRYPOINT ["/entrypoint.sh"]
