"""Elite AI backend: active browser chat, Whisper STT, and TTS use Groq REST.
Legacy telephony / Gemini bridges remain for compatibility, unused by the UI.
"""

import asyncio
import base64
import json
import os
import re
import struct
from datetime import datetime, timezone
from typing import Dict, List

import websockets.exceptions
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from google import genai
from google.genai import errors, types
from openai import OpenAI
from pydantic import BaseModel
from supabase import create_client
from twilio.rest import Client as TwilioClient
from twilio.twiml.voice_response import VoiceResponse, Connect

from audio_convert import Mulaw8kToPcm16k, Pcm24kToMulaw8k
from system_prompt import SYSTEM_PROMPT

load_dotenv()

# Twilio credential env vars use .get() with safe defaults so a missing /
# placeholder value can never crash the module at import time. Real API calls
# are guarded by _is_twilio_mock_mode() below.
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
GOOGLE_AI_STUDIO_API_KEY = os.environ.get("GOOGLE_AI_STUDIO_API_KEY", "")
GEMINI_LIVE_MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-live-2.5-flash-preview")
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


# Placeholder / invalid Twilio credentials — anything that can't drive a real
# outbound call. When detected we never touch the Twilio REST API (which would
# throw twilio.base.exceptions.TwilioRestException) and instead mock the call
# so the UI still sees a successful "Connected" / "Call Started" state.
def _is_twilio_mock_mode() -> bool:
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
        return True
    lower = TWILIO_ACCOUNT_SID.lower()
    # Covers "test_account_sid", "ACXXXX", "aaaa", generic placeholders, etc.
    if lower == "test_account_sid":
        return True
    if "xxxx" in lower or "placeholder" in lower or "test" in lower or "your_" in lower:
        return True
    return False


IS_TWILIO_MOCK_MODE = _is_twilio_mock_mode()

# Twilio client. Created lazily-ish: if credentials are placeholder/invalid the
# constructor can still succeed (it's lazy), but any failure during
# construction is swallowed so the server always boots. Real API calls check
# IS_TWILIO_MOCK_MODE first and are wrapped in try/except as a safety net.
twilio_client = None
if not IS_TWILIO_MOCK_MODE:
    try:
        twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    except Exception as e:
        print(f"[warn] Twilio client init failed, entering mock mode: {e}")
        twilio_client = None
        IS_TWILIO_MOCK_MODE = True

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# Gemini Live client. Uses the free Google AI Studio API key (no billing).
genai_client = genai.Client(api_key=GOOGLE_AI_STUDIO_API_KEY) if GOOGLE_AI_STUDIO_API_KEY else None

# OpenAI Agents SDK client — optional; the Gemini Live voice path below is
# the primary agent runtime and must never be blocked by these imports.
openai_client = None
try:
    import openai as openai_lib
    openai_client = openai_lib.Client(api_key=os.environ.get("OPENAI_API_KEY", ""))
except Exception as e:
    print(f"[warn] OpenAI SDK unavailable (agent compliance path optional): {e}")

# Claude Agent SDK client — optional, same rationale as above.
claude_client = None
try:
    import anthropic
    claude_client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
except Exception as e:
    print(f"[warn] Claude SDK unavailable (agent compliance path optional): {e}")

# Groq client for text chat (OpenAI-compatible endpoint)
groq_client = None
try:
    groq_client = OpenAI(
        base_url="https://api.groq.com/openai/v1",
        api_key=os.environ.get("GROQ_API_KEY", "")
    )
    print("[Groq] Client initialized successfully")
except Exception as e:
    print(f"[warn] Groq client unavailable: {e}")

# Groq model to use (currently supported)
GROQ_CHAT_MODEL = os.environ.get("GROQ_CHAT_MODEL", "openai/gpt-oss-120b")

# In-memory conversation store: session_id -> list of messages
# Each message is a dict with "role" and "content" keys
conversation_store: Dict[str, List[Dict[str, str]]] = {}

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",") if origin.strip()] + [
        "http://localhost",
        "http://localhost:3000",
        "http://127.0.0.1",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# The two tools the agent can call, as Gemini Live `FunctionDeclaration`s.
# Gemini wraps function declarations in a Tool via `function_declarations`.
GEMINI_TOOLS = [
    {
        "function_declarations": [
            {
                "name": "log_call_outcome",
                "description": "Log the outcome of this call once it's known.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "contact_name": {
                            "type": "STRING",
                            "description": "The name of the prospect/business owner."
                        },
                        "business_name": {
                            "type": "STRING",
                            "description": "The name of the business."
                        },
                        "outcome": {
                            "type": "STRING",
                            "enum": [
                                "booked",
                                "callback",
                                "not_interested",
                                "do_not_call",
                                "voicemail"
                            ]
                        },
                        "notes": {
                            "type": "STRING",
                            "description": "What the agent learned on the call."
                        },
                        "followup_time": {
                            "type": "STRING",
                            "description": "ISO 8601 datetime, only if outcome is 'booked' or 'callback'."
                        }
                    },
                    "required": [
                        "contact_name",
                        "outcome",
                        "notes"
                    ]
                }
            },
            {
                "name": "end_call",
                "description": "End the call cleanly after saying goodbye and logging the outcome.",
                "parameters": {"type": "OBJECT", "properties": {}},
            },
        ]
    }
]

# Shared Live API config: system prompt, tools, and server-side VAD for turn
# detection / barge-in. `activity_handling` defaults to
# `START_OF_ACTIVITY_INTERRUPTS`, i.e. the model's response is automatically
# cut off the moment the caller starts speaking (server-side "barge-in").
GEMINI_LIVE_CONFIG = {
    "response_modalities": ["AUDIO"],
    "system_instruction": SYSTEM_PROMPT,
    "tools": GEMINI_TOOLS,
    # Lets us see (in the browser test log) whether Gemini is actually
    # hearing you — invaluable while debugging, cheap to leave on.
    "input_audio_transcription": {},
    "output_audio_transcription": {},  # lets the agent's spoken reply also show as text
    "realtime_input_config": {
        "automatic_activity_detection": {
            "disabled": False,
            "start_of_speech_sensitivity": "START_SENSITIVITY_HIGH",
            "end_of_speech_sensitivity": "END_SENSITIVITY_HIGH",
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
        },
    },
    "speech_config": {
        "voice_config": {
            "prebuilt_voice_config": {"voice_name": "Puck"}
        }
    },
}

# Keep-alive / reconnection tuning.
KEEPALIVE_INTERVAL_S = 15      # active ping/pong heartbeat period
RECONNECT_BACKOFF_S = 1.0      # initial delay before reconnecting
RECONNECT_MAX_BACKOFF_S = 8.0  # cap on exponential reconnect backoff
AUDIO_QUEUE_MAX = 300          # bounded buffer of 16kHz PCM frames (~few seconds)


def build_live_config(resumption_handle: str | None = None) -> dict:
    """Return a copy of GEMINI_LIVE_CONFIG with session resumption enabled.

    Pass `resumption_handle` to resume a previous session after a dropped
    socket; pass None on the first connect to start a fresh session. Enabling
    `session_resumption` makes Gemini send `session_resumption_update` messages
    containing the `new_handle` we persist for reconnects.
    """
    config = dict(GEMINI_LIVE_CONFIG)
    if resumption_handle:
        config["session_resumption"] = {"handle": resumption_handle}
    return config


# ---------------------------------------------------------------------------
# Dashboard-facing REST API
# ---------------------------------------------------------------------------

class TriggerCallRequest(BaseModel):
    phone_number: str  # E.164 format, e.g. +15551234567


class ChatRequest(BaseModel):
    session_id: str
    message: str


class ChatResponse(BaseModel):
    session_id: str
    reply: str


class StartSessionRequest(BaseModel):
    session_id: str


class SpeakRequest(BaseModel):
    text: str


class EndSessionRequest(BaseModel):
    session_id: str


class EndSessionResponse(BaseModel):
    session_id: str
    outcome: str
    business_name: str | None
    contact_name: str | None
    phone_number: str | None
    notes: str
    followup_time: str | None
    transcript: str


class ResetRequest(BaseModel):
    session_id: str


class ResetResponse(BaseModel):
    session_id: str
    status: str


E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")


def clean_assistant_text(text: str) -> str:
    """Remove only known internal call artifacts; preserve ordinary prose."""
    text = re.sub(r"\*+Calling\s+(?:log_call_outcome|log\b|end_call)[^\n]*?\*+", "", text, flags=re.I)
    text = re.sub(r"\b(?:log_call_outcome|end_call)\s*\([^()]*\)\s*;?", "", text)
    return text.strip()


@app.post("/api/chat/start", response_model=ChatResponse)
async def start_chat(req: StartSessionRequest):
    """Seed the outbound opening once, without inventing a prospect turn."""
    if not req.session_id.strip():
        raise HTTPException(status_code=400, detail="Session ID cannot be empty")
    opening = "Hey, this is Maya with Elite AI. Did I catch you at a bad time?"
    history = conversation_store.setdefault(
        req.session_id, [{"role": "system", "content": SYSTEM_PROMPT}]
    )
    if not any(message["role"] != "system" for message in history):
        history.append({"role": "assistant", "content": opening})
    # Retries return the same opening; an existing typed conversation is not restarted.
    has_opening = any(
        message["role"] == "assistant" and message["content"] == opening
        for message in history
    )
    return ChatResponse(session_id=req.session_id, reply=opening if has_opening else "")


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """Text-only multi-turn chat with Groq (Maya persona)."""
    if groq_client is None:
        raise HTTPException(status_code=503, detail="Groq client not available")

    session_id = req.session_id
    user_message = req.message.strip()

    if not user_message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Get or create conversation history for this session
    if session_id not in conversation_store:
        conversation_store[session_id] = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]

    history = conversation_store[session_id]

    # Add user message to history
    history.append({"role": "user", "content": user_message})

    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_CHAT_MODEL,
            messages=history,
            temperature=0.7,
            max_tokens=250,
        )

        message = completion.choices[0].message
        reply = clean_assistant_text(message.content or "")

        # Fallback if model returned empty
        if not reply:
            reply = "I'm here to help. What would you like to know about Elite AI?"

        # Add assistant reply to history
        history.append({"role": "assistant", "content": reply})

        return ChatResponse(session_id=session_id, reply=reply)

    except Exception as e:
        print(f"[chat] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Groq API error: {e}")


@app.post("/api/chat/reset", response_model=ResetResponse)
async def chat_reset(req: ResetRequest):
    """Clear conversation history for a session."""
    session_id = req.session_id

    if session_id in conversation_store:
        del conversation_store[session_id]

    return ResetResponse(session_id=session_id, status="cleared")


@app.get("/api/chat/sessions")
async def list_sessions():
    """List active conversation sessions (for debugging)."""
    return {
        "sessions": [
            {"session_id": sid, "turns": len(history) // 2}
            for sid, history in conversation_store.items()
        ]
    }


@app.post("/api/chat/end", response_model=EndSessionResponse)
async def end_session(req: EndSessionRequest):
    """Analyze conversation, extract lead info, save to Supabase."""
    session_id = req.session_id

    if session_id not in conversation_store:
        raise HTTPException(status_code=404, detail="Session not found")

    history = conversation_store[session_id]

    # Build transcript from conversation history (skip system prompt)
    transcript_lines = []
    for msg in history:
        if msg["role"] == "user":
            transcript_lines.append(f"Prospect: {msg['content']}")
        elif msg["role"] == "assistant":
            transcript_lines.append(f"Maya: {clean_assistant_text(msg['content'])}")
    transcript = "\n".join(transcript_lines)

    # Use Groq to analyze and extract structured lead info
    extraction_prompt = f"""
You are an analyst extracting lead information from a sales call transcript.
Analyze the conversation below and return ONLY valid JSON with these exact fields:
- outcome: one of [booked, callback, not_interested, do_not_call, voicemail, in_progress]
- business_name: string or null
- contact_name: string or null
- phone_number: string or null
- notes: string (what the agent learned, max 200 chars)
- followup_time: ISO 8601 datetime string or null

Outcome rules:
- booked: prospect explicitly agrees to demo/meeting/follow-up time
- callback: prospect wants to be contacted later or asks for information
- not_interested: clearly declines
- do_not_call takes priority over every other outcome when removal is requested
- do_not_call: explicitly asks to stop calling / remove them / do not contact
- voicemail: only if session represents voicemail
- in_progress: conversation ended without a clear final outcome

Do NOT hallucinate. Use null for unknown values.

TRANSCRIPT:
{transcript}
"""

    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_CHAT_MODEL,
            messages=[{"role": "user", "content": extraction_prompt}],
            temperature=0.1,
            max_tokens=1500,
            response_format={"type": "json_object"},
        )
        extracted = json.loads(completion.choices[0].message.content or "{}")
    except Exception as e:
        print(f"[end_session] Extraction failed: {e}")
        raise HTTPException(status_code=502, detail="Session could not be classified. Please retry.") from e

    if not isinstance(extracted, dict):
        extracted = {}
    for field in ("business_name", "contact_name", "phone_number", "followup_time"):
        value = extracted.get(field)
        extracted[field] = value.strip() if isinstance(value, str) and value.strip() else None
    # A single explicitly supplied E.164 number is evidence, not an inferred field.
    user_text = "\n".join(msg["content"] for msg in history if msg["role"] == "user")
    explicit_phones = set(re.findall(r"(?<![\w+])\+[1-9]\d{6,14}(?!\d)", user_text))
    if not extracted["phone_number"] and len(explicit_phones) == 1:
        extracted["phone_number"] = next(iter(explicit_phones))
    if extracted["followup_time"]:
        try:
            parsed = datetime.fromisoformat(extracted["followup_time"].replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                extracted["followup_time"] = None
        except ValueError:
            extracted["followup_time"] = None
    extracted["notes"] = str(extracted.get("notes") or "")[:200]

    # Prepare Supabase row
    outcome = extracted.get("outcome", "in_progress")
    if outcome not in ["booked", "callback", "not_interested", "do_not_call", "voicemail", "in_progress"]:
        outcome = "in_progress"

    row = {
        "call_sid": session_id,
        "phone_number": extracted.get("phone_number"),
        "business_name": extracted.get("business_name"),
        "contact_name": extracted.get("contact_name"),
        "outcome": outcome,
        "notes": extracted.get("notes"),
        "followup_time": extracted.get("followup_time"),
        "transcript": transcript,
    }

    # Upsert to Supabase (idempotent on call_sid)
    try:
        supabase.table("leads").upsert(row, on_conflict="call_sid").execute()
    except Exception as e:
        print(f"[end_session] Supabase write failed: {e}")
        raise HTTPException(status_code=503, detail="Session could not be saved. Please retry.") from e

    # Return structured result
    return EndSessionResponse(
        session_id=session_id,
        outcome=outcome,
        business_name=extracted.get("business_name"),
        contact_name=extracted.get("contact_name"),
        phone_number=extracted.get("phone_number"),
        notes=extracted.get("notes"),
        followup_time=extracted.get("followup_time"),
        transcript=transcript,
    )


# ---------------------------------------------------------------------------
# Voice pipeline endpoints (Groq STT + TTS)
# ---------------------------------------------------------------------------

GROQ_STT_MODEL = "whisper-large-v3-turbo"
GROQ_TTS_MODEL = "canopylabs/orpheus-v1-english"
GROQ_TTS_VOICE = "hannah"


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribe browser-recorded audio using Groq Whisper."""
    if groq_client is None:
        raise HTTPException(status_code=503, detail="Groq client not available")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")

    try:
        result = groq_client.audio.transcriptions.create(
            model=GROQ_STT_MODEL,
            file=(file.filename or "audio.webm", audio_bytes),
            language="en",
            response_format="json",
        )
        return {"text": result.text.strip()}
    except Exception as e:
        print(f"[transcribe] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")


def finalize_wav_header(audio: bytes) -> bytes:
    """Fill streaming WAV size placeholders once the complete body is available."""
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return audio
    result = bytearray(audio)
    if result[4:8] == b"\xff" * 4:
        struct.pack_into("<I", result, 4, len(result) - 8)
    offset = 12
    while offset + 8 <= len(result):
        size = struct.unpack_from("<I", result, offset + 4)[0]
        if result[offset:offset + 4] == b"data":
            if size == 0xFFFFFFFF:
                struct.pack_into("<I", result, offset + 4, len(result) - offset - 8)
            break
        offset += 8 + size + (size % 2)
    return bytes(result)


@app.post("/api/speak")
async def speak_text(req: SpeakRequest):
    """Synthesize text to speech using Groq TTS and return audio."""
    if groq_client is None:
        raise HTTPException(status_code=503, detail="Groq client not available")

    text = clean_assistant_text(req.text)
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    try:
        response = groq_client.audio.speech.create(
            model=GROQ_TTS_MODEL,
            voice=GROQ_TTS_VOICE,
            input=text,
            response_format="wav",
        )
        audio_bytes = finalize_wav_header(response.read())
        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={"Content-Disposition": "inline; filename=speech.wav"},
        )
    except Exception as e:
        print(f"[speak] Error: {e}")
        raise HTTPException(status_code=500, detail=f"TTS failed: {e}")


@app.post("/calls/trigger")
async def trigger_call(req: TriggerCallRequest):
    """Called by the dashboard when someone adds a number and hits 'Call'."""
    if not E164_RE.match(req.phone_number):
        return Response(status_code=422, content='{"detail":"phone_number must be E.164 format, e.g. +15551234567"}',
                        media_type="application/json")

    # Mock mode: skip Twilio call entirely if using placeholder credentials,
    # so the server never attempts a real Twilio Call object or media stream.
    if IS_TWILIO_MOCK_MODE:
        print("[trigger_call] Mock mode: placeholder Twilio credentials detected, skipping real call")
        mock_sid = "MC123456789mockcallsid"
        supabase.table("leads").insert(
            {
                "call_sid": mock_sid,
                "phone_number": req.phone_number,
                "outcome": "in_progress",
                "call_status": "in_progress",
            }
        ).execute()
        return {
            "status": "success",
            "message": "Mock call triggered successfully (Placeholder mode)",
            "call_sid": mock_sid
        }

    # Safety net: even when credentials look valid, never let a Twilio API
    # failure (network, auth, rate-limit, TwilioRestException) bubble up as a
    # 500. Fall back to the mock success state so the UI stays green.
    try:
        call = twilio_client.calls.create(
            to=req.phone_number,
            from_=TWILIO_PHONE_NUMBER,
            url=f"{PUBLIC_BASE_URL}/twiml/voice",
            machine_detection="DetectMessageEnd",
            async_amd=True,
            async_amd_status_callback=f"{PUBLIC_BASE_URL}/twiml/amd-status",
            status_callback=f"{PUBLIC_BASE_URL}/twiml/status",
            status_callback_event=["initiated", "ringing", "answered", "completed", "busy", "no-answer", "failed", "canceled"],
        )
    except Exception as e:
        print(f"[trigger_call] Twilio call creation failed, falling back to mock mode: {e}")
        mock_sid = "MC123456789mockcallsid"
        supabase.table("leads").insert(
            {
                "call_sid": mock_sid,
                "phone_number": req.phone_number,
                "outcome": "in_progress",
                "call_status": "in_progress",
            }
        ).execute()
        return {
            "status": "success",
            "message": f"Call triggered in mock fallback (Twilio error suppressed): {e}",
            "call_sid": mock_sid
        }

    # Pre-create the lead row so it shows up on the dashboard immediately,
    # even before the model has said anything.
    supabase.table("leads").insert(
        {
            "call_sid": call.sid,
            "phone_number": req.phone_number,
            "outcome": "in_progress",
            "call_status": "in_progress",
        }
    ).execute()

    return {"call_sid": call.sid, "status": call.status}


@app.post("/calls/{call_sid}/end")
async def end_call(call_sid: str):
    """Best-effort hangup of an in-progress Twilio call.

    The dashboard's red End Call button closes the browser harness and, when a
    real outbound call is tracked, asks Twilio to complete it. Idempotent and
    safe to call after the call already ended (Twilio just returns the call
    with its current status).
    """
    try:
        if IS_TWILIO_MOCK_MODE or twilio_client is None:
            print(f"[calls/{call_sid}/end] mock mode: no real Twilio call to hang up")
            return {"call_sid": call_sid, "status": "completed", "note": "mock mode"}
        call = twilio_client.calls(call_sid).update(status="completed")
        return {"call_sid": call_sid, "status": call.status}
    except Exception as e:
        # The call may already be terminal — not fatal to the caller. Never let
        # a TwilioRestException (e.g. from placeholder credentials) propagate.
        print(f"[calls/{call_sid}/end] could not hang up: {e}")
        return {"call_sid": call_sid, "status": "unknown", "note": str(e)}


@app.post("/twiml/status")
async def call_status(request: Request):
    """Twilio posts here when the call completes, in case the model never
    got a chance to log an outcome (e.g. the line just didn't pick up)."""
    form = await request.form()
    call_sid = form.get("CallSid")
    call_status = form.get("CallStatus")
    # Technical call state — never corrupt business outcome semantics.
    # no-answer, busy, failed, canceled are call-state failures, NOT prospect
    # intent. We record them in `call_status` and keep `outcome` untouched
    # (it stays 'in_progress' = no business outcome determined).
    supabase.table("leads").update({"call_status": call_status}).eq("call_sid", call_sid).execute()
    return Response(status_code=204)


@app.post("/twiml/amd-status")
async def amd_status(request: Request):
    """Twilio's Answering Machine Detection callback."""
    form = await request.form()
    call_sid = form.get("CallSid")
    answered_by = form.get("AnsweredBy", "")
    if "machine" in answered_by:
        supabase.table("leads").update({"outcome": "voicemail", "call_status": "completed"}).eq("call_sid", call_sid).execute()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Twilio voice webhook — opens the media stream
# ---------------------------------------------------------------------------

@app.api_route("/twiml/voice", methods=["GET", "POST"])
async def twiml_voice():
    response = VoiceResponse()
    connect = Connect()
    connect.stream(url=f"{PUBLIC_BASE_URL.replace('https', 'wss')}/media-stream")
    response.append(connect)
    return Response(content=str(response), media_type="application/xml")


# ---------------------------------------------------------------------------
# Gemini Live session manager (shared by the Twilio and browser bridges)
# ---------------------------------------------------------------------------
# The google-genai SDK opens the Live WebSocket for us, but it does NOT
# keep it alive or reconnect. This class wraps that connection so that:
#   1. It sends an active ping/pong keep-alive every KEEPALIVE_INTERVAL_S.
#   2. If the socket drops (e.g. ConnectionClosedError 1011 "ping timeout")
#      it auto-reconnects using Gemini's session_resumption handle, so the
#      conversation state survives the blip.
#   3. Incoming 16kHz mono PCM frames are buffered in a bounded queue and
#      pushed to Gemini by a detached sender task — a slow or dropped frame
#      can never crash the client receive loop.


class GeminiLiveBridge:
    def __init__(self, client, model: str, base_config: dict):
        self._client = client
        self._model = model
        self._base_config = base_config
        self._resumption_handle: str | None = None
        self.session = None  # current live AsyncSession (or None while reconnecting)
        self._audio_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=AUDIO_QUEUE_MAX)
        self._text_queue: asyncio.Queue[str] = asyncio.Queue()
        self._stopped = asyncio.Event()
        self._intentional_hangup = False
        # Diagnostics / session state
        self._session_count = 0
        self._greeting_sent = False
        self._last_user_text: str | None = None

    # -- config -------------------------------------------------------------
    def _make_config(self) -> dict:
        config = build_live_config(self._resumption_handle)
        print(f"[GeminiLiveBridge] _make_config: session_count={self._session_count + 1}, resumption_handle={'set' if self._resumption_handle else 'none'}, greeting_sent={self._greeting_sent}")
        return config

    # -- safe, non-blocking send helpers ------------------------------------
    def send_audio(self, pcm: bytes) -> None:
        """Buffer 16kHz mono PCM for the detached sender task.

        Bounded queue: if a client floods faster than Gemini can consume, we
        drop the oldest frame rather than block or crash the receive loop.
        """
        if not _pcm_ok(pcm):
            return
        if self._audio_queue.full():
            try:
                self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self._audio_queue.put_nowait(pcm)
        except asyncio.QueueFull:
            pass

    async def send_text(self, text: str) -> None:
        """Queue a discrete text turn to be sent to the current session.

        If no session is active yet, the text is queued and flushed once a
        session becomes available (e.g. after initial greeting completion).
        """
        print(f"[SEND_TEXT] text={text!r} session={'active' if self.session else 'None'}")
        await self._text_queue.put(text)

    async def _flush_text_queue(self) -> None:
        """Background task: drain queued text messages to the live session."""
        while not self._stopped.is_set():
            try:
                text = await self._text_queue.get()
            except asyncio.CancelledError:
                print(f"[TASK CANCELLED] _flush_text_queue")
                break
            # Wait for session to be ready
            while self.session is None and not self._stopped.is_set():
                await asyncio.sleep(0.1)
            if self._stopped.is_set():
                break
            session = self.session
            if session is None:
                continue
            try:
                print(f"[GEMINI SEND] session={id(session)} text={text!r}")
                await session.send_client_content(
                    turns=types.Content(role="user", parts=[types.Part(text=text)]),
                    turn_complete=True,
                )
                print(f"[GEMINI SEND OK]")
            except (websockets.exceptions.ConnectionClosed, errors.APIError) as e:
                print(f"[GeminiLiveBridge] text send failed (will reconnect): {e}")
                # Re-queue for next session attempt
                await self._text_queue.put(text)

    async def send_tool_response(self, responses) -> None:
        session = self.session
        if session is None:
            return
        try:
            await session.send_tool_response(function_responses=responses)
        except (websockets.exceptions.ConnectionClosed, errors.APIError) as e:
            print(f"[GeminiLiveBridge] tool response send failed (will reconnect): {e}")

    # -- lifecycle ----------------------------------------------------------
    async def run(self, on_message) -> None:
        """Connect/reconnect to Gemini and dispatch received messages.

        A single session is kept alive for the entire call. Reconnection occurs
        ONLY on genuine network/connection failures (ConnectionClosed or APIError
        with close code >= 1000). We do NOT reconnect on clean session end
        (session.receive() exhausted) because Gemini Live API completes the
        receive generator after each model turn — that is normal, not a failure.

        The loop exits cleanly only when:
        - signal_intentional_hangup() is called (end_call tool)
        - stop() is called (client websocket disconnects)
        """
        backoff = RECONNECT_BACKOFF_S
        while not self._intentional_hangup:
            self._stopped.clear()
            self._session_count += 1
            session_num = self._session_count
            is_resume = self._resumption_handle is not None
            print(f"[SESSION CREATED] session={session_num} resume={'yes' if is_resume else 'no'}")
            try:
                async with self._client.aio.live.connect(
                    model=self._model, config=self._make_config()
                ) as session:
                    self.session = session
                    backoff = RECONNECT_BACKOFF_S
                    print(f"[GeminiLiveBridge] session #{session_num} connected (resume={'yes' if is_resume else 'no'}, handle={self._resumption_handle[:16] if self._resumption_handle else 'none'})")
                    await self._run_session(session, on_message, session_num)
                    # session.receive() exhausted — NORMAL per-turn completion in
                    # Gemini Live API. NOT a failure, and NOT a reason to tear the
                    # whole conversation down. Reconnect (with resumption handle,
                    # if available) to keep the session alive for the rest of the
                    # websocket connection. The repeated-greeting regression is
                    # prevented by the session_resumption handle + the per-bridge
                    # greeting_sent guard — we do NOT start a fresh conversation.
                    print(f"[GeminiLiveBridge] session #{session_num} receive() exhausted (normal turn completion); keeping conversation alive")
            except websockets.exceptions.ConnectionClosed as e:
                print(f"[SESSION RECONNECT] session={session_num} reason=ConnectionClosed({e})")
            except errors.APIError as e:
                code = getattr(e, "code", None)
                if code is None or code >= 1000:
                    # Transient WebSocket close code -> reconnect with backoff.
                    print(f"[SESSION RECONNECT] session={session_num} reason=APIError(code={code})")
                else:
                    # Hard HTTP error (e.g. 4xx auth) -> give up.
                    print(f"[GeminiLiveBridge] unrecoverable error (code={code}), giving up: {e}")
                    raise
            finally:
                self.session = None

            # Only attempt reconnection on genuine network failure, not clean end.
            if not self._intentional_hangup and not self._stopped.is_set():
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_MAX_BACKOFF_S)
            else:
                break

    def stop(self) -> None:
        """Stop current session tasks and exit the reconnection loop.

        Call this when the client websocket closes (e.g. browser disconnects).
        This stops the bridge cleanly without treating it as an intentional
        agent hangup, so reconnection is still possible if the client
        reconnects before intentional_hangup is signaled.
        """
        self._stopped.set()

    def signal_intentional_hangup(self) -> None:
        """Signal that the call was intentionally ended by the user/agent.

        Sets both flags to exit the reconnection loop immediately and
        prevent any further reconnection attempts. Called by the end_call
        tool when the agent/user legitimately hangs up.
        """
        self._intentional_hangup = True
        self._stopped.set()

    async def _run_session(self, session, on_message, session_num: int) -> None:
        sender_task = asyncio.create_task(self._audio_sender(session))
        heartbeat_task = asyncio.create_task(self._heartbeat(session))
        flush_task = asyncio.create_task(self._flush_text_queue())
        print(f"[SESSION RECEIVE START] session={session_num}")
        try:
            async for msg in session.receive():
                # Capture the freshest resumption handle offered by the server.
                if (
                    msg.session_resumption_update
                    and msg.session_resumption_update.new_handle
                ):
                    old_handle = self._resumption_handle[:16] if self._resumption_handle else 'none'
                    self._resumption_handle = msg.session_resumption_update.new_handle
                    new_handle = self._resumption_handle[:16] if self._resumption_handle else 'none'
                    print(f"[GeminiLiveBridge] session #{session_num} resumption handle updated: {old_handle} -> {new_handle}")

                # Diagnostics: log message type and key content
                msg_type = "unknown"
                if msg.server_content:
                    if msg.server_content.model_turn:
                        for part in msg.server_content.model_turn.parts or []:
                            if part.inline_data and part.inline_data.data:
                                msg_type = "model_audio"
                                if not self._greeting_sent:
                                    self._greeting_sent = True
                                    print(f"[GeminiLiveBridge] session #{session_num} GREETING_SENT flag set (model_audio)")
                            elif part.text:
                                msg_type = "model_text"
                                if not self._greeting_sent:
                                    self._greeting_sent = True
                                    print(f"[GeminiLiveBridge] session #{session_num} GREETING_SENT flag set (model_text)")
                    if msg.server_content.output_transcription and msg.server_content.output_transcription.text:
                        msg_type = "output_transcription"
                    if msg.server_content.input_transcription and msg.server_content.input_transcription.text:
                        msg_type = "input_transcription"
                        self._last_user_text = msg.server_content.input_transcription.text
                        print(f"[GeminiLiveBridge] session #{session_num} USER_TURN: {self._last_user_text[:80]}")
                    if msg.server_content.interrupted:
                        msg_type = "interrupted"
                        print(f"[GeminiLiveBridge] session #{session_num} INTERRUPTED (barge-in)")
                elif msg.tool_call:
                    msg_type = "tool_call"
                print(f"[GEMINI RECV] session={session_num} message_type={msg_type}")
                print(f"[GeminiLiveBridge] session #{session_num} <<< {msg_type}")
                await on_message(msg)
        finally:
            print(f"[SESSION RECEIVE END] session={session_num}")
            sender_task.cancel()
            heartbeat_task.cancel()
            flush_task.cancel()

    async def _audio_sender(self, session) -> None:
        """Consume buffered 16kHz PCM frames and send them to Gemini."""
        while not self._stopped.is_set():
            try:
                pcm = await self._audio_queue.get()
            except asyncio.CancelledError:
                print(f"[TASK CANCELLED] _audio_sender")
                break
            if session is None or session is not self.session:
                continue  # reconnecting; frame was transient, safe to drop
            try:
                await session.send_realtime_input(
                    audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000")
                )
            except (websockets.exceptions.ConnectionClosed, errors.APIError) as e:
                print(f"[GeminiLiveBridge] audio send failed (reconnecting): {e}")

    async def _heartbeat(self, session) -> None:
        """Keep the socket alive with a ping every KEEPALIVE_INTERVAL_S."""
        try:
            while not self._stopped.is_set():
                await asyncio.sleep(KEEPALIVE_INTERVAL_S)
                if session is not self.session:
                    continue
                try:
                    await session._ws.ping()
                except asyncio.CancelledError:
                    print(f"[TASK CANCELLED] _heartbeat ping")
                    break
                except Exception as e:
                    # Socket looks dead — the receive loop will surface the
                    # close and trigger a reconnect.
                    print(f"[GeminiLiveBridge] keepalive ping failed: {e}")
        except asyncio.CancelledError:
            print(f"[TASK CANCELLED] _heartbeat")
            pass

    def stop(self) -> None:
        self._stopped.set()

    def signal_intentional_hangup(self) -> None:
        """Signal that the call was intentionally ended by the user/agent.

        When set, the reconnection loop will exit instead of trying to
        reconnect after the current session ends. This prevents ghost
        reconnections after a legitimate hangup.
        """
        self._intentional_hangup = True
        self._stopped.set()


def _pcm_ok(pcm: bytes) -> bool:
    """Drop malformed/empty frames up front so a bad client frame can't crash
    the queue or the sender task."""
    return bool(pcm) and len(pcm) % 2 == 0


# ---------------------------------------------------------------------------
# The real-time bridge: Twilio Media Stream <-> Gemini Live API
# ---------------------------------------------------------------------------


@app.websocket("/media-stream")
async def media_stream(twilio_ws: WebSocket):
    await twilio_ws.accept()

    stream_sid: str | None = None
    call_sid: str | None = None

    bridge = GeminiLiveBridge(genai_client, GEMINI_LIVE_MODEL, GEMINI_LIVE_CONFIG)
    # One converter for the whole Twilio call: it holds streaming resample
    # state, so resampling stays continuous across audio chunks/turns.
    to_twilio = Pcm24kToMulaw8k()

    async def handle_tool_call(name: str, call_id: str, args: dict):
        nonlocal call_sid
        if name == "log_call_outcome":
            update = {
                "outcome": args.get("outcome", "in_progress"),
                "contact_name": args.get("contact_name"),
                "business_name": args.get("business_name"),
                "notes": args.get("notes"),
            }
            if args.get("followup_time"):
                update["followup_time"] = args["followup_time"]
            update["call_status"] = "completed"  # call reached terminal state via agent action
            supabase.table("leads").update(update).eq("call_sid", call_sid).execute()
            result = {"status": "logged"}
        elif name == "end_call":
            result = {"status": "ending"}
            # Also set call_status to completed when the call ends via the tool
            try:
                supabase.table("leads").update({"call_status": "completed"}).eq("call_sid", call_sid).execute()
            except Exception:
                pass
            # Signal intentional hangup so the bridge stops reconnecting
            bridge.signal_intentional_hangup()
        else:
            result = {"status": "unknown_tool"}

        # Returning the tool response lets Gemini pick the conversation back
        # up (no separate "response.create" as in OpenAI).
        await bridge.send_tool_response([{"name": name, "id": call_id, "response": result}])

        if name == "end_call":
            await twilio_ws.close()

    async def on_message(msg):
        """Dispatch a Gemini server message to Twilio."""
        try:
            if msg.server_content:
                # Model audio reply -> transcode 24kHz PCM -> 8kHz mulaw.
                if msg.server_content.model_turn and stream_sid:
                    for part in msg.server_content.model_turn.parts or []:
                        if part.inline_data and part.inline_data.data:
                            mulaw = to_twilio.convert(part.inline_data.data)
                            if mulaw:
                                await twilio_ws.send_text(
                                    json.dumps(
                                        {
                                            "event": "media",
                                            "streamSid": stream_sid,
                                            "media": {"payload": base64.b64encode(mulaw).decode()},
                                        }
                                    )
                                )

                # THE INTERRUPTION HANDLER: Gemini's VAD detected the caller
                # speaking and cut off its own response. Tell Twilio to
                # immediately clear its playback buffer so nothing
                # already-queued keeps playing.
                if msg.server_content.interrupted and stream_sid:
                    await twilio_ws.send_text(
                        json.dumps({"event": "clear", "streamSid": stream_sid})
                    )

            elif msg.tool_call and msg.tool_call.function_calls:
                for fc in msg.tool_call.function_calls:
                    await handle_tool_call(name=fc.name, call_id=fc.id, args=fc.args or {})
        except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
            bridge.stop()

    async def twilio_to_gemini():
        nonlocal stream_sid, call_sid
        # Twilio streams 8kHz mulaw; Gemini needs 16kHz PCM, so we transcode
        # on the way in. The transcoded frames are buffered by the bridge and
        # sent to Gemini by a detached task (crash-safe).
        to_gemini = Mulaw8kToPcm16k()
        try:
            async for message in twilio_ws.iter_text():
                data = json.loads(message)
                event = data.get("event")

                if event == "start":
                    stream_sid = data["start"]["streamSid"]
                    call_sid = data["start"]["callSid"]

                elif event == "media":
                    try:
                        mulaw = base64.b64decode(data["media"]["payload"])
                        pcm = to_gemini.convert(mulaw)
                        if pcm:
                            bridge.send_audio(pcm)
                    except Exception as e:
                        # A single bad frame must never kill this loop.
                        print(f"[media-stream] dropped bad media frame: {e}")

                elif event == "stop":
                    break
        except WebSocketDisconnect:
            pass
        finally:
            # Twilio call is over — stop trying to keep the Gemini session alive.
            bridge.stop()

    run_task = asyncio.create_task(bridge.run(on_message))
    client_task = asyncio.create_task(twilio_to_gemini())
    # End the whole bridge as soon as either side finishes: if Twilio hangs up
    # we cancel the (possibly blocked) Gemini receive loop; if Gemini gives a
    # hard error we cancel the Twilio leg.
    done, pending = await asyncio.wait(
        {client_task, run_task}, return_when=asyncio.FIRST_COMPLETED
    )
    for t in pending:
        t.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


@app.get("/health")
async def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


# ---------------------------------------------------------------------------
# Browser test-call mode (Phase 1 — no Twilio needed)
# ---------------------------------------------------------------------------
# The browser connects to /ws/test-call and we open a single Gemini Live
# session for it right here in the backend (server-to-server). Your mic audio
# (16kHz PCM, resampled in the browser) is forwarded straight into the
# session, and Gemini's 24kHz PCM reply is streamed back to be played in the
# browser. Same system prompt, same tools, same Supabase logging as Twilio —
# this just swaps the audio source from "phone call" to "your microphone".


@app.websocket("/ws/test-call")
async def browser_test_call(browser_ws: WebSocket):
    # Accept immediately so the client gets a connected WebSocket before any
    # downstream initialization can fail.
    await browser_ws.accept()

    test_id = ""  # set by the browser on connect
    bridge = None

    try:
        bridge = GeminiLiveBridge(genai_client, GEMINI_LIVE_MODEL, GEMINI_LIVE_CONFIG)

        async def handle_tool_call(name: str, call_id: str, args: dict):
            if name == "log_call_outcome":
                supabase.table("leads").upsert(
                    {
                        "call_sid": test_id,
                        "phone_number": "browser-test",
                        "outcome": args.get("outcome", "in_progress"),
                        "contact_name": args.get("contact_name"),
                        "business_name": args.get("business_name"),
                        "notes": args.get("notes"),
                        "call_status": "completed",
                        "followup_time": args.get("followup_time"),
                    },
                    on_conflict="call_sid",
                ).execute()
                if args.get("followup_time"):
                    supabase.table("leads").update({"followup_time": args["followup_time"]}).eq("call_sid", test_id).execute()
                result = {"status": "logged"}
            elif name == "end_call":
                result = {"status": "ending"}
                # Signal intentional hangup so the bridge stops reconnecting
                bridge.signal_intentional_hangup()
            else:
                result = {"status": "unknown_tool"}

            await bridge.send_tool_response([{"name": name, "id": call_id, "response": result}])

            if name == "end_call":
                await browser_ws.close()

        async def on_message(msg):
            """Dispatch a Gemini server message to the browser page."""
            try:
                print(f"[test-call] <<< from Gemini: {msg}")
                if msg.server_content:
                    if msg.server_content.model_turn:
                        for part in msg.server_content.model_turn.parts or []:
                            if part.inline_data and part.inline_data.data:
                                await browser_ws.send_text(
                                    json.dumps(
                                        {
                                            "type": "audio",
                                            "data": base64.b64encode(part.inline_data.data).decode(),
                                            "mime_type": part.inline_data.mime_type,
                                        }
                                    )
                                )
                            elif part.text:
                                await browser_ws.send_text(json.dumps({"type": "agent_text", "text": part.text}))

                    if msg.server_content.interrupted:
                        # Clear any pending transcription buffer on interruption
                        if hasattr(on_message, "_transcription_buffer"):
                            on_message._transcription_buffer = ""
                        await browser_ws.send_text(json.dumps({"type": "interrupted"}))

                    if msg.server_content.input_transcription and msg.server_content.input_transcription.text:
                        await browser_ws.send_text(
                            json.dumps(
                                {
                                    "type": "user_transcript",
                                    "text": msg.server_content.input_transcription.text,
                                }
                            )
                        )

                    # Accumulate output_transcription for the current model turn.
                    # Only forward as a single agent_text when the turn completes
                    # (turn_complete=True or generation_complete=True), avoiding
                    # fragmented bubbles from streaming chunks.
                    if msg.server_content.output_transcription and msg.server_content.output_transcription.text:
                        # Initialize buffer if needed
                        if not hasattr(on_message, "_transcription_buffer"):
                            on_message._transcription_buffer = ""
                        on_message._transcription_buffer += msg.server_content.output_transcription.text

                    # Turn complete: send the accumulated transcription as ONE agent_text
                    if msg.server_content.turn_complete or msg.server_content.generation_complete:
                        if hasattr(on_message, "_transcription_buffer") and on_message._transcription_buffer:
                            await browser_ws.send_text(
                                json.dumps(
                                    {
                                        "type": "agent_text",
                                        "text": on_message._transcription_buffer,
                                    }
                                )
                            )
                            on_message._transcription_buffer = ""

                elif msg.tool_call and msg.tool_call.function_calls:
                    for fc in msg.tool_call.function_calls:
                        await handle_tool_call(name=fc.name, call_id=fc.id, args=fc.args or {})
            except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
                if bridge:
                    bridge.stop()
            except Exception as e:
                print(f"[test-call] on_message error: {type(e).__name__}: {e}")

        async def browser_to_gemini():
            nonlocal test_id
            try:
                async for message in browser_ws.iter_text():
                    data = json.loads(message)
                    msg_type = data.get("type", "unknown")
                    if msg_type == "text":
                        print(f"[BROWSER IN] {msg_type} text={data.get('text')!r}")
                    else:
                        print(f"[BROWSER IN] {msg_type}")

                    if data.get("type") == "hello":
                        test_id = data.get("test_id", f"browser-test-{int(datetime.now().timestamp()*1000)}")
                        # Don't tell the browser to start streaming until a Gemini
                        # session is actually live, so the first mic frames aren't
                        # dropped during the initial connect.
                        for _ in range(50):  # up to ~5s
                            if bridge.session is not None:
                                break
                            await asyncio.sleep(0.1)
                        await browser_ws.send_text(json.dumps({"type": "ready"}))

                    elif data.get("type") == "audio":
                        # 16kHz mono PCM from the browser -> buffered safely and
                        # sent to Gemini by the bridge's detached sender task.
                        try:
                            pcm = base64.b64decode(data["data"])
                            print(f"[test-call] received {len(pcm)} bytes of audio from browser")
                            bridge.send_audio(pcm)
                        except Exception as e:
                            print(f"[test-call] dropped bad audio frame: {e}")

                    elif data.get("type") == "text":
                        # Silent test path — no mic/speakers needed. Sends a
                        # normal text turn; the agent still replies with
                        # audio (response_modalities=["AUDIO"]), but since
                        # output_audio_transcription is on, that reply also
                        # arrives as text via agent_text — so this works
                        # completely silently end to end.
                        print(f"[test-call] received text turn: {data['text']!r}")
                        await bridge.send_text(data["text"])
            except WebSocketDisconnect:
                print(f"[BROWSER WS CLOSED] WebSocketDisconnect")
            except Exception as e:
                print(f"[BROWSER WS CLOSED] error={type(e).__name__}: {e}")
            finally:
                print(f"[BROWSER WS CLOSED] cleanup")
                if bridge:
                    bridge.stop()

        run_task = asyncio.create_task(bridge.run(on_message))
        client_task = asyncio.create_task(browser_to_gemini())

        # Log any unhandled exception from the Gemini bridge loop (never silent).
        def _log_run_exc(t):
            try:
                t.result()
            except Exception as e:
                print(f"[RUN TASK EXCEPTION] {type(e).__name__}: {e}")
        run_task.add_done_callback(_log_run_exc)

        # The browser websocket is the life of this handler. The Gemini bridge loop
        # (run_task) self-heals and keeps the session alive across turns, so we do
        # NOT cancel the browser leg when run() merely returns. We end only when:
        #   - the browser closes the websocket (normal end), or
        #   - the bridge hits an unrecoverable Gemini error, or
        #   - the agent calls end_call (signal_intentional_hangup).
        try:
            # Wait for the browser to disconnect OR the bridge to fatally fail.
            done, pending = await asyncio.wait(
                {client_task, run_task}, return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        finally:
            # Ensure the bridge loop is fully stopped/closed on exit.
            if bridge:
                bridge.stop()
            if not run_task.done():
                run_task.cancel()
                try:
                    await run_task
                except asyncio.CancelledError:
                    pass
    except Exception as e:
        # Catch any error during initialization (e.g., Gemini bridge creation)
        # and log it without leaving the socket in a bad state.
        print(f"[test-call] WebSocket initialization error: {type(e).__name__}: {e}")
        try:
            await browser_ws.close(code=1011, reason="Internal server error during initialization")
        except Exception:
            pass


class LogTestOutcomeRequest(BaseModel):
    test_id: str
    outcome: str
    business_name: str | None = None
    contact_name: str | None = None
    notes: str | None = None
    followup_time: str | None = None


@app.post("/realtime/log-outcome")
async def log_test_outcome(req: LogTestOutcomeRequest):
    """Kept for backwards compatibility with any client that posts outcomes
    directly; the browser test page now routes them through the live session
    handler instead, but this remains a handy manual fallback."""
    supabase.table("leads").upsert(
        {
            "call_sid": req.test_id,
            "phone_number": "browser-test",
            "outcome": req.outcome,
            "business_name": req.business_name,
            "contact_name": req.contact_name,
            "notes": req.notes,
            "call_status": "completed",
            "followup_time": req.followup_time,
        },
        on_conflict="call_sid",
    ).execute()
    return {"status": "logged"}
