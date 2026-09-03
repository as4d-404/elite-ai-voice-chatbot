# Elite AI Voice Agent

An outbound AI sales voice agent for home-service businesses. Built with FastAPI, Next.js, Supabase, Twilio, and Google Gemini Live API.

## Overview

Elite AI Voice Agent is a code-based outbound AI sales voice agent designed to engage home-service business owners, qualify prospects, handle objections, and move interested leads toward a demo or handoff.

The agent runs on **Google Gemini Live** (Google AI Studio, free tier) for low-latency speech-to-speech conversation with server-side VAD and barge-in. The same system prompt and tools are engineerable across OpenAI Agents SDK and Claude Agent SDK for compliance paths.

## Features

- **Live Voice Conversation**: Browser-based test harness connects your microphone directly to the Gemini Live agent (no Twilio required)
- **Outbound Twilio Calls**: Trigger real phone calls from the dashboard
- **Real-time Lead Dashboard**: Supabase realtime subscriptions show leads updating live
- **Interruption Handling**: Server-side VAD with `START_OF_ACTIVITY_INTERRUPTS` stops the agent instantly when the prospect speaks
- **Outcome Logging**: Agent calls `log_call_outcome` tool to record results (booked, callback, not_interested, voicemail, do_not_call)
- **Call History**: Transcripts and outcomes stored in Supabase

## Architecture

```
┌─────────────────┐     WebSocket      ┌──────────────┐     gRPC/WebSocket     ┌─────────────────┐
│  Browser /      │ ◄────────────────► │  FastAPI     │ ◄────────────────────► │  Google Gemini  │
│  Twilio Media   │   8kHz mu-law      │  Backend     │      16/24kHz PCM      │  Live API       │
│  Stream         │                    │  (Bridge)    │   audio_convert.py     │  (Gemini Live)  │
└─────────────────┘                    └──────────────┘                        └─────────────────┘
        │                                      │                                       │
        ▼                                      ▼                                       ▼
┌─────────────────┐                    ┌──────────────┐                        ┌─────────────────┐
│  Next.js        │                    │  Supabase    │                        │  Twilio         │
│  Dashboard      │ ◄────────────────► │  (PostgreSQL │                        │  (Telephony)    │
│  (Next.js)      │   Realtime         │  + Realtime) │                        │                 │
└─────────────────┘                    └──────────────┘                        └─────────────────┘
```

### Core Components

- **`backend/`** — FastAPI service: triggers Twilio calls, bridges live call audio to Google Gemini Live API, handles interruption/barge-in, logs outcomes to Supabase
- **`backend/system_prompt.py`** — Full conversation design / system prompt for the AI sales agent
- **`backend/audio_convert.py`** — Transcoding between Twilio's 8kHz mu-law and Gemini Live's 16/24kHz PCM
- **`frontend/`** — Next.js dashboard: add a number, trigger a call, watch leads come in live via Supabase realtime
- **`supabase/schema.sql`** — The `leads` table + realtime setup

### Why Gemini Live?

Twilio Media Streams sends call audio as 8kHz mu-law. OpenAI's Realtime API accepted that format natively, but **Gemini Live does not** — it expects raw 16-bit little-endian PCM at 16kHz for input and returns 24kHz PCM. `audio_convert.py` sits in the middle: it decodes Twilio's 8kHz mu-law → 16kHz PCM on the way in, and resamples Gemini's 24kHz PCM → 8kHz mu-law on the way out.

Interruption handling works via Gemini's **server-side voice-activity detection (VAD)** with `START_OF_ACTIVITY_INTERRUPTS` ("barge-in") as default. The moment the server detects the caller speaking, it **automatically cuts off the model's in-flight response** and signals with `serverContent.interrupted`. We send Twilio a `clear` event to wipe anything already queued for playback.

## Screenshots

### Voice Agent Dashboard

![Elite AI Voice Agent Dashboard](screenshots/dashboard.png)


## Running Locally

### Prerequisites (all have free tiers/trial credit)

- **Twilio** — buy a phone number (~$1.15/mo). US numbers on trial accounts can only call verified numbers.
- **Google AI Studio** — get a free `GOOGLE_AI_STUDIO_API_KEY` at https://aistudio.google.com/app/apikey (free tier, no billing). Powers the Gemini Live voice layer.
- **Supabase** — create a project, run `supabase/schema.sql` in the SQL editor.
- **ngrok** (or similar) — Twilio needs a public HTTPS/WSS URL. Run `ngrok http 8000` after the backend is running.

### Backend

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in all keys, including the ngrok URL
uvicorn main:app --reload --port 8000
```

Once ngrok is running, update `PUBLIC_BASE_URL` in `.env` to match its current URL (it changes on free-tier restarts) and restart uvicorn.

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill in Supabase + backend URL
npm run dev
```

Open http://localhost:3000, enter a number in E.164 format (e.g. `+15551234567`), hit **Start Outbound Call**.

## Testing Without Twilio (do this first)

Visit http://localhost:3000/test-call — this connects your browser mic to the same Gemini Live agent running on the backend (WebSocket relay to `/ws/test-call`), using the same `system_prompt.py` and tools as the real Twilio path. It logs outcomes to Supabase the same way, so they show up on the main dashboard too.

This lets you validate the whole agent (conversation quality, barge-in, tool calls, live dashboard updates) before Twilio is funded/working — only needs Supabase + a free Google AI Studio key, no Twilio account required.

## Recording the Demo Clip

Call your own second line (a personal cell works) so you can act as the prospect. Record 2-3 minutes covering: the opening, you talking over the agent mid-sentence (to show it stops instantly), and one objection from the list in `system_prompt.py`.

## Current Status

The repository contains the current candidate-task implementation including:

- Dashboard with live conversation workspace, lead details panel, call history, and settings
- Browser voice-agent test interface (`/test-call`) with full microphone/audio support
- Backend integration with Gemini Live for speech-to-speech conversation
- Twilio outbound call triggering with webhook handling (AMD, status callbacks)
- Lead storage and realtime updates via Supabase
- Call outcome workflow with tool-based logging

**Known limitations (not addressed in this UI pass):**

- Voicemail message content is currently generic — could be tailored per business type
- No retry/backoff logic on Twilio or Gemini websocket drops
- Browser test page relies on output_transcription for text display (Gemini Live only returns text when transcription is explicitly enabled)
- RLS policy in `schema.sql` is open for demo purposes — tighten before any real usage
- Occasional DNS/handshake timeouts to Gemini Live API during session establishment

## Environment Variables

### Backend (`backend/.env`)

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
PUBLIC_BASE_URL=https://your-ngrok-subdomain.ngrok-free.app
GOOGLE_AI_STUDIO_API_KEY=
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-preview
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

### Frontend (`frontend/.env.local`)

```
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

## License

MIT
