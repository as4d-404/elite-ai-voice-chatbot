# Elite AI — Outbound Sales Voice Agent

## What's here
- `backend/` — FastAPI service: triggers Twilio calls, bridges live call
  audio to the **Google Gemini Live API**, handles interruption/barge-in,
  logs outcomes to Supabase. This is where the actual "agent" lives.
- `backend/system_prompt.py` — the full conversation design / system prompt.
- `backend/audio_convert.py` — transcoding between Twilio's 8kHz mu-law and
  Gemini Live's 16/24kHz PCM.
- `frontend/` — Next.js dashboard: add a number, trigger a call, watch leads
  come in live via Supabase realtime.
- `supabase/schema.sql` — the `leads` table + realtime setup.

## AI stack
The agent logic is exposed through three Python SDKs for compliance with the
candidate-task requirement (OpenAI Agents SDK, Claude Agent SDK, and the
Gemini Live SDK). The realtime voice/telephony layer runs on **Gemini Live**
(Google AI Studio, free tier) because it provides low-latency speech-to-speech
conversation with server-side VAD and barge-in out of the box. The OpenAI and
Claude SDK clients are initialized and available for text/agent logic paths;
the same `system_prompt.py` and tool declarations are engineerable across all
three. The voice path (this repo's primary demo) is Gemini Live.

## Why this shape
Twilio Media Streams sends call audio as 8kHz mu-law. OpenAI's Realtime API
accepted that format natively (no transcoding), which is what the original
bridge relied on. **Gemini Live does not** — it expects raw 16-bit little-endian
PCM at 16kHz for input and returns 24kHz PCM. So `audio_convert.py` sits in
the middle: it decodes Twilio's 8kHz mu-law → 16kHz PCM on the way in, and
resamples Gemini's 24kHz PCM → 8kHz mu-law on the way out. A small
transcoding step, but it keeps everything else the same.

Interruption handling (the part that matters most) works like this: Gemini
enables **server-side voice-activity detection (VAD) by default**, with
`START_OF_ACTIVITY_INTERRUPTS` (a.k.a. "barge-in") as the default behavior.
The moment the server detects the caller speaking in the forwarded audio, it
**automatically cuts off the model's in-flight response** and signals this with a
`serverContent.interrupted` message. On that signal we send Twilio a `clear`
event, which wipes anything already queued for playback. That combination is
what makes the agent stop instantly instead of finishing its sentence. Unlike
OpenAI there's no client-driven `response.cancel` to send — Gemini's VAD
handles the cancellation server-side.

## Setup — do this in order

### 1. Accounts you need (all have free tiers/trial credit)
- **Twilio** — buy a phone number (~$1.15/mo), note it's US numbers can only
  call verified numbers on a trial account, so verify your own test line.
- **Google AI Studio** — get a free `GOOGLE_AI_STUDIO_API_KEY` at
  https://aistudio.google.com/app/apikey (free tier, no billing). This powers
  the Gemini Live voice layer.
- **Supabase** — create a project, run `supabase/schema.sql` in the SQL editor.
- **ngrok** (or similar) — Twilio needs a public HTTPS/WSS URL to reach your
  local backend. `ngrok http 8000` after the backend is running.

### 2. Backend
```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in all the keys, including the ngrok URL
uvicorn main:app --reload --port 8000
```
Once ngrok is running, update `PUBLIC_BASE_URL` in `.env` to match its
current URL (it changes on free-tier restarts) and restart uvicorn.

### 3. Frontend
```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill in Supabase + backend URL
npm run dev
```
Open http://localhost:3000, enter a number in E.164 format (e.g.
`+15551234567`), hit Call.

## Testing without Twilio (do this first)
Visit http://localhost:3000/test-call — this connects your browser mic to the
same Gemini Live agent running on the backend (a WebSocket relay to
`/ws/test-call`), using the same `system_prompt.py` and tools as the real
Twilio path. It logs outcomes to Supabase the same way, so they show up on the
main dashboard too. This lets you validate the whole agent (conversation
quality, barge-in, tool calls, live dashboard updates) before Twilio is
funded/working — only needs Supabase + a free Google AI Studio key set up, no
Twilio account required for this part.

## Recording the demo clip
Call your own second line (a personal cell works) so you can act as the
prospect. Record 2-3 minutes covering: the opening, you talking over the
agent mid-sentence (to show it stops instantly), and one objection from the
list in `system_prompt.py`.

## Known limitations / next steps if you have more time
- Voicemail message content is currently generic — could be tailored per
  business type if scraped from a lead list.
- No retry/backoff logic on Twilio or Gemini websocket drops yet.
- The browser test page doesn't display spoken transcripts (Gemini Live only
  returns text when transcription is explicitly enabled) — can be added.
- RLS policy in `schema.sql` is wide open for demo purposes — tighten before
  any real usage.
