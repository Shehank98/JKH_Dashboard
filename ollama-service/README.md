# ollama-service

A small Ollama server for the dashboard's **Full report → Short notes on each slide**. It downloads and serves two models:

| Model | Use it when |
|---|---|
| `llama3.2:3b` | Default. Good plain-English notes. |
| `qwen2.5:3b` | Follows "use only the numbers on screen" a little more strictly. Try both on one report and keep the one you like. |

Change the list with the `PRELOAD_MODELS` variable (space separated).

## Run it on your PC
```
cd ollama-service
docker compose up -d
```
Open the dashboard locally, the notes option appears on its own (the app looks at `http://127.0.0.1:11434`).
Without Docker: install Ollama, then `ollama pull llama3.2:3b` and `ollama pull qwen2.5:3b`.

## Deploy on Railway (next to the dashboard)
1. New service from this repo, **Settings → Root Directory = `/ollama-service`**.
2. Add a **volume** mounted at `/root/.ollama` (otherwise the models download again on every deploy, about 4 GB in total).
3. Give it at least **8 GB RAM** (3B models run on CPU; expect roughly 5–10 seconds per slide note).
4. Do not give it a public domain. Only the dashboard needs to reach it.
5. In the **dashboard** service add variables:
   - `OLLAMA_URL` = `http://ollama-service.railway.internal:11434` (use your service's name)
   - `OLLAMA_MODEL` = `llama3.2:3b` (optional, the model chosen first in the dialog)

First start takes a few minutes while the models download; the dialog shows the notes option once `/api/ai/status` can see them.
