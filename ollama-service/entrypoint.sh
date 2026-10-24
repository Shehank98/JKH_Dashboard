#!/bin/sh
# Start Ollama, download the models that are missing, then keep serving.
ollama serve &
SERVER=$!
until ollama list >/dev/null 2>&1; do sleep 1; done
for m in $PRELOAD_MODELS; do
  if ollama list | awk 'NR>1{print $1}' | grep -qx "$m"; then echo "model $m already here"; else echo "downloading $m"; ollama pull "$m" || echo "could not download $m"; fi
done
echo "ollama-service ready: $(ollama list | awk 'NR>1{print $1}' | tr '\n' ' ')"
wait $SERVER
