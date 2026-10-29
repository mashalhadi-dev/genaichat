# Cinematic Gemini AI

A Next.js App Router chat UI backed by Google Gen AI. Conversations and model
preferences are stored in the browser's local storage; the Gemini API key stays
on the server. Gemini responses stream into the chat as they are generated, with
exponential backoff retries and live application request-capacity feedback.

## Setup

1. Install dependencies with `npm install`.
2. Set `GOOGLE_GENAI_API_KEY` (or `GEMINI_API_KEY`) in `.env.local`.
3. Optionally set `RATE_LIMIT_MAX_REQUESTS` to change the per-process hourly
   request cap (default: `60`).
4. Start the app with `npm run dev`.

The chat accepts PNG, JPEG, PDF, TXT, Markdown, CSV, and JSON files (up to 8 MB
each, five files per request). Chat sessions and model selection are local to
the current browser and are not shared across browsers or devices.

## Monitoring

Open `/app/admin` for request counts, Gemini-reported token usage, known model
context-window information, and recent operational logs. The hourly request
limit is an application-level, process-local limit; it does not report Google's
provider quota. In-memory monitoring and limiting reset when the server restarts
and are not shared between deployment instances. Production deployments with
multiple instances should replace these with shared telemetry and a distributed
rate limiter.
