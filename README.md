# Elite AI Voice Agent

A browser voice and text workspace for Maya, Elite AI’s sales assistant. The active routes (`/` and `/test-call`) use the same `VoiceAgent` component and Groq REST pipeline:

`record → /api/transcribe → /api/chat → /api/speak → browser audio`

Typed and voice messages share a session ID and server history. Stop recording to automatically submit speech. Mic and typed interruption stop current playback and invalidate pending audio. Navigation keeps the conversation mounted. Ending a session classifies the outcome and upserts its readable transcript to Supabase, then explicitly refreshes leads. Failed saves can be retried.

The Tailwind v4 dashboard shows saved-session data, outcome distribution, recent sessions, follow-ups, and a frontend session timer. Leads include outcome filters; History includes expandable and copyable transcripts. Realtime is not required.

## Local setup

Backend (Python environment with `backend/requirements.txt` installed):

```sh
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Set these in a local `backend/.env` (never commit it):

```text
GROQ_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ALLOWED_ORIGINS=http://localhost:3000
```

`GROQ_CHAT_MODEL` optionally overrides the existing `openai/gpt-oss-120b` model. STT uses `whisper-large-v3-turbo`; TTS uses `canopylabs/orpheus-v1-english`, voice `hannah`. Local origins are allowed; add the exact future frontend origin to comma-separated `ALLOWED_ORIGINS` before a later deployment.

Frontend:

```sh
cd frontend
npm ci
npm run dev
```

Set `frontend/.env.local`:

```text
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Only a public anon key belongs in the frontend. Microphone access requires localhost or HTTPS. Click the mic again to stop and submit a recording. Browser playback permission and physical microphone quality need device testing.

## Database setup / required migration

`supabase/schema.sql` describes the table and unique `call_sid` used for idempotent upserts. **An existing database with `phone_number NOT NULL` must apply the following migration before browser sessions without a phone can be saved:**

```sql
alter table public.leads alter column phone_number drop not null;
```

This pass does not apply remote schema changes. Unknown phone numbers remain `null`; they are never fabricated to bypass the constraint. The current demo RLS policy permits public access; replace it with an appropriate access policy before exposing customer data. No auth was added in this pass. Realtime publication setup is optional.

## Verification

```sh
python -m py_compile backend/main.py backend/system_prompt.py
python tests/backend_regression.py
npm run build --prefix frontend
```

Offline tests replace providers and cover history, sanitization, audio contracts, supported outcomes, save failure/retry, and unique upserts. `python tests/browser_regression.py` runs headless Chrome against locally served build artifacts, with API/microphone fixtures and a real WAV from the live test; screenshots go to `/tmp/elite-verification`. `python tests/live_api_check.py` is an opt-in live test that consumes provider requests and creates/removes uniquely identified regression rows. It does not change historical data or schema.

## Boundaries

Legacy Gemini / telephony backend routes and the unused `LiveHarness.js` remain for compatibility. They are not imported or invoked by either rendered browser page. No telephony, deployment, or push is part of this work.

Session memory is process-local: use one backend worker for this version. Restarting the backend loses unfinished conversation history. The connected database migration above is required for no-phone persistence. Metrics describe saved rows, not unsaved browser sessions; unavailable data is shown as a dash.
