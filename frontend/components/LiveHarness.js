import { useCallback, useEffect, useRef, useState } from "react";
import {
  Phone,
  Mic,
  MicOff,
  Bot,
  User,
  Send,
  Loader2,
  StopCircle,
  X,
} from "lucide-react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;
const WS_URL = `${(BACKEND_URL || "").replace(/^http/, "ws").replace(/\/$/, "")}/ws/test-call`;
const E164 = /^\+[1-9]\d{6,14}$/;

const STATUS_META = {
  idle: {
    label: "Ready",
    pill: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
    dot: "bg-zinc-500",
  },
  connecting: {
    label: "Connecting…",
    pill: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
    dot: "bg-cyan-400 animate-pulse",
  },
  live: {
    label: "Live Call in Progress",
    pill: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    dot: "bg-emerald-400",
    ring: true,
  },
  ended: {
    label: "Call Ended",
    pill: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
    dot: "bg-zinc-500",
  },
};

let bubbleSeq = 0;
const now = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function LiveHarness({ onCallStateChange }) {
  const [status, setStatus] = useState("idle");
  const [prospectName, setProspectName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [bubbles, setBubbles] = useState([]);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState(Array(24).fill(0));
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [error, setError] = useState("");
  const [outbound, setOutbound] = useState(null);
  const [chatStatus, setChatStatus] = useState("idle"); // idle | thinking | error
  const [recordingStatus, setRecordingStatus] = useState("idle"); // idle | recording | transcribing | speaking

  const statusRef = useRef("idle");
  const wsRef = useRef(null);
  const testIdRef = useRef(null);
  const micCtxRef = useRef(null);
  const outCtxRef = useRef(null);
  const processorRef = useRef(null);
  const micStreamRef = useRef(null);
  const playBufsRef = useRef([]);
  const nextTimeRef = useRef(0);
  const mutedRef = useRef(false);
  const levelCounterRef = useRef(0);
  const speakTimerRef = useRef(null);
  const scrollRef = useRef(null);
  const sessionIdRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const voiceAudioRef = useRef(null); // persistent Audio element for TTS playback

  // Initialize persistent audio element on first user gesture (mic click / start call)
  function ensureAudioElement() {
    if (!voiceAudioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      voiceAudioRef.current = audio;
    }
    return voiceAudioRef.current;
  }

  // Shared TTS helper: called by both typed and voice paths
  async function speakAgentReply(reply) {
    setRecordingStatus("speaking");
    try {
      const res = await fetch(`${BACKEND_URL}/api/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });
      console.log("[TTS] /api/speak status:", res.status);
      console.log("[TTS] Content-Type:", res.headers.get("content-type"));

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      console.log("[TTS] blob size:", blob.size, "type:", blob.type);

      if (blob.size === 0) {
        appendBubble("system", "Voice playback unavailable (empty audio).");
        setRecordingStatus("idle");
        return;
      }

      const audio = ensureAudioElement();
      const url = URL.createObjectURL(blob);
      // Revoke previous URL if any
      if (audio._blobUrl) URL.revokeObjectURL(audio._blobUrl);
      audio._blobUrl = url;
      audio.src = url;
      audio.volume = 1;

      setAgentSpeaking(true);
      audio.onended = () => {
        setAgentSpeaking(false);
        setRecordingStatus("idle");
      };
      audio.onerror = (e) => {
        console.error("[TTS] audio.onerror:", e);
        setAgentSpeaking(false);
        setRecordingStatus("idle");
        appendBubble("system", "Voice playback unavailable.");
      };

      const playPromise = audio.play();
      if (playPromise) {
        playPromise
          .then(() => console.log("[TTS] playback started"))
          .catch((err) => {
            console.error("[TTS] playback failed:", err);
            setAgentSpeaking(false);
            setRecordingStatus("idle");
            appendBubble("system", "Voice playback blocked by browser. Click anywhere to unmute.");
          });
      }
    } catch (err) {
      console.error("[TTS] /api/speak error:", err);
      appendBubble("system", "Voice playback unavailable.");
      setRecordingStatus("idle");
    }
  }

  const setStatusNow = useCallback((s) => {
    statusRef.current = s;
    setStatus(s);
    if (onCallStateChange) onCallStateChange(s);
  }, [onCallStateChange]);

  const appendBubble = useCallback((who, text, open = false) => {
    setBubbles((prev) => [
      ...prev.slice(-200),
      { id: ++bubbleSeq, who, text, time: now(), open },
    ]);
  }, []);

  const addTurnText = useCallback((who, text) => {
    setBubbles((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.who === who && last.open) {
        return [...prev.slice(0, prev.length - 1), { ...last, text: last.text + text }].slice(-200);
      }
      return [
        ...prev.slice(-200),
        { id: ++bubbleSeq, who, text, time: now(), open: true },
      ];
    });
  }, []);

  const closeOpenBubble = useCallback(() => {
    setBubbles((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      if (!last.open) return prev;
      return [...prev.slice(0, prev.length - 1), { ...last, open: false }];
    });
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [bubbles, agentSpeaking]);

  useEffect(() => {
    return () => cleanupStreams();
  }, []);

  function schedulePlayback() {
    const ctx = outCtxRef.current;
    if (!ctx) return;
    while (playBufsRef.current.length) {
      const buf = playBufsRef.current.shift();
      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(ctx.destination);
      const start = Math.max(ctx.currentTime, nextTimeRef.current);
      source.start(start);
      nextTimeRef.current = start + buf.duration;
    }
  }

  function enqueuePcm(base64pcm) {
    let bytes;
    try {
      const bin = atob(base64pcm);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return;
    }
    const samples = new Int16Array(bytes.buffer);
    const ctx = outCtxRef.current;
    if (!ctx || !samples.length) return;
    const float = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) float[i] = samples[i] / 32768;
    const buf = ctx.createBuffer(1, float.length, 24000);
    buf.copyToChannel(float, 0);
    playBufsRef.current.push(buf);
    schedulePlayback();
  }

  function downsampleTo16k(float32, inputRate) {
    if (inputRate === 16000) return float32;
    const ratio = inputRate / 16000;
    const outLength = Math.floor(float32.length / ratio);
    const result = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 96) {
      const end = Math.min(i + 96, outLength);
      for (let j = i; j < end; j++) {
        const srcIndex = j * ratio;
        const i0 = Math.floor(srcIndex);
        const i1 = Math.min(i0 + 1, float32.length - 1);
        const frac = srcIndex - i0;
        result[j] = float32[i0] * (1 - frac) + float32[i1] * frac;
      }
    }
    return result;
  }

  function startMic() {
    const micCtx = new AudioContext();
    micCtxRef.current = micCtx;
    const processor = micCtx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    processor.onaudioprocess = (e) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || mutedRef.current) return;
      const raw = e.inputBuffer.getChannelData(0);
      const data = downsampleTo16k(raw, micCtx.sampleRate);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / Math.max(1, data.length));
      levelCounterRef.current += 1;
      if (levelCounterRef.current % 5 === 0) {
        const target = Math.min(1, rms * 6);
        setLevels((prev) => prev.map(() => Math.max(0.04, target * (0.7 + Math.random() * 0.4))));
      }
      const int16 = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const bytes = new Uint8Array(int16.buffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({ type: "audio", data: btoa(bin) }));
    };
    const source = micCtx.createMediaStreamSource(micStreamRef.current);
    source.connect(processor);
  }

  function cleanupStreams() {
    try {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      
    }
    try {
      processorRef.current?.disconnect();
    } catch {
      
    }
    try {
      micCtxRef.current?.close();
    } catch {
      
    }
    try {
      outCtxRef.current?.close();
    } catch {
      
    }
    try {
      wsRef.current?.close();
    } catch {
      
    }
    // Stop any in-progress voice recording or playback
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {}
    try {
      if (voiceAudioRef.current) {
        voiceAudioRef.current.pause();
        voiceAudioRef.current.src = "";
      }
    } catch {}
    if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
  }

  async function triggerTwilio(phone) {
    const res = await fetch(`${BACKEND_URL}/calls/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: phone }),
    });
    if (!res.ok) {
      let msg = "Twilio trigger failed";
      try {
        msg = JSON.parse(await res.text()).detail || msg;
      } catch {
        
      }
      throw new Error(msg);
    }
    const data = await res.json();
    setOutbound({ callSid: data.call_sid, status: data.status, phone });
    return data;
  }

  async function startCall() {
    setError("");
    const phone = phoneNumber.trim();
    if (phone && !E164.test(phone)) {
      setError("Phone must be E.164 format, e.g. +15551234567");
      return;
    }

    setStatusNow("connecting");
    setBubbles([]);
    sessionIdRef.current = crypto.randomUUID();
    testIdRef.current = `browser-test-${Date.now()}`;
    appendBubble("system", "Starting voice session…");

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      micStreamRef.current = micStream;
    } catch {
      setStatusNow("idle");
      appendBubble("system", "Microphone access denied — allow mic access to talk. Text mode still works.");
    }

    const outCtx = new AudioContext({ sampleRate: 24000 });
    outCtxRef.current = outCtx;
    nextTimeRef.current = outCtx.currentTime;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    console.log("[LiveHarness] Connecting to WebSocket:", WS_URL);

    ws.addEventListener("open", () => {
      console.log("[LiveHarness] WebSocket opened");
      ws.send(JSON.stringify({ type: "hello", test_id: testIdRef.current }));
    });

    ws.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        setStatusNow("live");
        appendBubble("system", "Connected — start talking whenever you're ready.");
        if (micStreamRef.current) startMic();
        if (phone) {
          triggerTwilio(phone).catch((err) => {
            appendBubble("system", `Outbound dial: ${err.message || err}`);
          });
        }
      } else if (msg.type === "audio") {
        enqueuePcm(msg.data);
      } else if (msg.type === "agent_text") {
        addTurnText("agent", msg.text);
        setAgentSpeaking(true);
        if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
        speakTimerRef.current = setTimeout(() => {
          setAgentSpeaking(false);
          closeOpenBubble();
        }, 1400);
      } else if (msg.type === "user_transcript") {
        addTurnText("prospect", msg.text);
      } else if (msg.type === "interrupted") {
        setAgentSpeaking(false);
        closeOpenBubble();
        appendBubble("system", "Interrupted — you spoke first.");
      }
    });

    ws.addEventListener("error", (e) => {
      console.error("[LiveHarness] WebSocket error:", e);
      setStatusNow("ended");
      appendBubble("system", `WebSocket error — check backend is running. (see console)`);
    });

    ws.addEventListener("close", (e) => {
      console.log("[LiveHarness] WebSocket closed:", {
        code: e.code,
        reason: e.reason,
        wasClean: e.wasClean,
      });
      setAgentSpeaking(false);
      if (statusRef.current !== "idle" && statusRef.current !== "ended") {
        setStatusNow("ended");
        appendBubble("system", `Connection closed (code=${e.code}, clean=${e.wasClean}).`);
      }
    });
  }

  async function endCall() {
    cleanupStreams();
    setAgentSpeaking(false);
    setLevels(Array(24).fill(0));
    setStatusNow("ended");
    setChatStatus("idle")
    setRecordingStatus("idle")
    appendBubble("system", "Call ended. Finalizing session…");

    // Finalize session in backend (extract lead, save to Supabase)
    if (sessionIdRef.current) {
      try {
        const res = await fetch(`${BACKEND_URL}/api/chat/end`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        });
        if (res.ok) {
          const data = await res.json();
          appendBubble("system", `Session saved: ${data.outcome}`);
          console.log("[LiveHarness] Session finalized:", data);
          // Supabase realtime will refresh the leads panel automatically
        } else {
          const err = await res.json().catch(() => ({ detail: "unknown" }));
          appendBubble("system", `Failed to save session: ${err.detail || "unknown"}`);
        }
      } catch (err) {
        console.error("[LiveHarness] /api/chat/end error:", err);
        appendBubble("system", "Failed to save session (check console).");
      }

      // Reset chat session
      try {
        await fetch(`${BACKEND_URL}/api/chat/reset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        });
      } catch {}
      sessionIdRef.current = null;
    }
    if (outbound && outbound.callSid) {
      try {
        await fetch(`${BACKEND_URL}/calls/${outbound.callSid}/end`, { method: "POST" });
      } catch {
        
      }
    }
    setOutbound(null);
  }

  function toggleMute() {
    mutedRef.current = !mutedRef.current;
    setMuted((m) => {
      if (m) setLevels(Array(24).fill(0));
      return !m;
    });
  }

  async function handleSendText() {
    const t = textInput.trim();
    if (!t || chatStatus === "thinking" || recordingStatus !== "idle") return;

    // Create session ID on first message
    if (!sessionIdRef.current) {
      sessionIdRef.current = crypto.randomUUID();
    }

    appendBubble("prospect", t);
    setTextInput("");
    setChatStatus("thinking");

    try {
      const res = await fetch(`${BACKEND_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          message: t,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }

      const data = await res.json();
      appendBubble("agent", data.reply);
      setChatStatus("idle");

      // Play TTS for typed messages too (if audio element is unlocked)
      if (voiceAudioRef.current) {
        speakAgentReply(data.reply);
      }
    } catch (err) {
      console.error("[LiveHarness] /api/chat error:", err);
      appendBubble("system", "Unable to reach the agent.");
      setChatStatus("error");
    }
  }

  // --- Voice pipeline: record → transcribe → chat → speak → play ---

  async function toggleRecording() {
    if (recordingStatus === "recording") {
      // Stop recording
      mediaRecorderRef.current?.stop();
      return;
    }

    if (recordingStatus !== "idle") return; // already processing

    try {
      // Initialize audio element on user gesture (unlocks autoplay)
      ensureAudioElement();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await processVoiceAudio(audioBlob);
      };

      mediaRecorder.start();
      setRecordingStatus("recording");
    } catch (err) {
      console.error("[LiveHarness] Microphone access denied:", err);
      appendBubble("system", "Microphone access denied — allow mic access to use voice.");
    }
  }

  async function processVoiceAudio(audioBlob) {
    setRecordingStatus("transcribing");

    // Ensure session exists
    if (!sessionIdRef.current) {
      sessionIdRef.current = crypto.randomUUID();
    }

    // 1. Transcribe
    let transcript;
    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "recording.webm");
      const res = await fetch(`${BACKEND_URL}/api/transcribe`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      transcript = data.text.trim();
    } catch (err) {
      console.error("[LiveHarness] /api/transcribe error:", err);
      appendBubble("system", "Unable to transcribe audio.");
      setRecordingStatus("idle");
      return;
    }

    if (!transcript) {
      appendBubble("system", "No speech detected.");
      setRecordingStatus("idle");
      return;
    }

    // 2. Show transcript ONCE as prospect bubble
    appendBubble("prospect", transcript);

    // 3. Send transcript to /api/chat
    setChatStatus("thinking");
    let reply;
    try {
      const res = await fetch(`${BACKEND_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          message: transcript,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      reply = data.reply;
    } catch (err) {
      console.error("[LiveHarness] /api/chat error:", err);
      appendBubble("system", "Unable to reach the agent.");
      setChatStatus("error");
      setRecordingStatus("idle");
      return;
    }

    // 4. Show agent reply ONCE
    appendBubble("agent", reply);
    setChatStatus("idle");

    // 5. Send to /api/speak and play (shared helper)
    await speakAgentReply(reply);
  }

  const meta = STATUS_META[status] || STATUS_META.idle;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <header className="glass flex flex-col gap-3 rounded-2xl px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-cyan-400" />
          <div>
            <div className="text-sm font-semibold text-zinc-100">
              Prospect: <span className="text-cyan-300">{prospectName || "Prospect"}</span>
            </div>
            <div className="text-xs text-zinc-500">Elite AI Voice Agent · outbound sales</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {outbound ? (
            <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300">
              Twilio dialing {outbound.phone}
            </span>
          ) : null}
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium ${
              recordingStatus === "recording"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                : recordingStatus === "transcribing"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : recordingStatus === "speaking"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : chatStatus === "thinking"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : meta.pill
            }`}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                recordingStatus === "recording"
                  ? "bg-rose-400 animate-pulse"
                  : recordingStatus === "transcribing"
                  ? "bg-amber-400 animate-pulse"
                  : recordingStatus === "speaking"
                  ? "bg-emerald-400"
                  : chatStatus === "thinking"
                  ? "bg-amber-400 animate-pulse"
                  : `${meta.dot} ${meta.ring ? "pulse-dot text-emerald-400" : ""}`
              }`}
            />
            {recordingStatus === "recording"
              ? "Recording…"
              : recordingStatus === "transcribing"
              ? "Transcribing…"
              : recordingStatus === "speaking"
              ? "Speaking…"
              : chatStatus === "thinking"
              ? "Thinking…"
              : meta.label}
          </span>
        </div>
      </header>

      <section className="glass flex min-h-0 flex-1 flex-col rounded-2xl overflow-hidden">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {bubbles.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Bot className="h-12 w-12 text-cyan-500/50" />
              <p className="max-w-sm text-sm text-zinc-500">
                Start a call or type a message to begin the conversation.
              </p>
            </div>
          )}

          {bubbles.map((b, i) => {
            const isAgent = b.who === "agent";
            const isSystem = b.who === "system";
            if (isSystem) {
              return (
                <div key={b.id} className="bubble-in text-center">
                  <span className="rounded-full border border-zinc-500/20 bg-zinc-500/10 px-3 py-1 text-[11px] text-zinc-500">
                    {b.text}
                  </span>
                </div>
              );
            }
            return (
              <div
                key={b.id}
                className={`bubble-in flex gap-3 ${isAgent ? "" : "flex-row-reverse"} items-start`}
              >
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                    isAgent
                      ? "border-cyan-500/40 bg-cyan-500/20 text-cyan-300"
                      : "border-indigo-500/40 bg-indigo-500/20 text-indigo-300"
                  }`}
                >
                  {isAgent ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
                </div>
                <div
                  className={`max-w-[78%] rounded-2xl px-4 py-3 ${
                    isAgent
                      ? "border border-cyan-500/25 bg-zinc-900/90 text-zinc-100"
                      : "bg-gradient-to-br from-indigo-600/85 to-blue-600/85 text-white"
                  }`}
                >
                  {isAgent && (
                    <div className="mb-1 flex items-center justify-between gap-3">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">
                        Maya · Elite AI
                      </span>
                      <span className="text-[10px] tabular-nums text-zinc-500">{b.time}</span>
                    </div>
                  )}
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{b.text}</p>
                </div>
              </div>
            );
          })}

          {agentSpeaking && (
            <div className="bubble-in flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/20 text-cyan-300">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-2 rounded-full border border-cyan-500/25 bg-zinc-900/90 px-4 py-2">
                <span className="speak-dots">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="text-xs text-cyan-300">Maya speaking…</span>
              </div>
            </div>
          )}

          {chatStatus === "thinking" && !agentSpeaking && (
            <div className="bubble-in flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/20 text-cyan-300">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-2 rounded-full border border-cyan-500/25 bg-zinc-900/90 px-4 py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />
                <span className="text-xs text-cyan-300">Thinking…</span>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-cyan-500/15 p-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={prospectName}
              onChange={(e) => setProspectName(e.target.value)}
              placeholder="Prospect name"
              className="rounded-lg border border-zinc-700/60 bg-zinc-900/70 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-cyan-500/60"
            />
            <input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+15551234567"
              inputMode="tel"
              className="rounded-lg border border-zinc-700/60 bg-zinc-900/70 px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-cyan-500/60"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendText(); } }}
              placeholder="Type a message to Maya…"
              disabled={chatStatus === "thinking" || recordingStatus !== "idle"}
              className="flex-1 rounded-lg border border-zinc-700/60 bg-zinc-900/70 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-cyan-500/60 disabled:opacity-50"
            />
            <button
              onClick={handleSendText}
              disabled={!textInput.trim() || chatStatus === "thinking" || recordingStatus !== "idle"}
              aria-label="Send message"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/15 text-cyan-300 transition hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {chatStatus === "thinking" ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="wave-track" aria-hidden="true">
              {levels.map((l, i) => (
                <span key={i} style={{ height: `${Math.round((l || 0.04) * 22)}px` }} />
              ))}
            </div>

            {/* Push-to-talk mic button */}
            <button
              onClick={toggleRecording}
              disabled={recordingStatus === "transcribing" || recordingStatus === "speaking"}
              aria-label={recordingStatus === "recording" ? "Stop recording" : "Start recording"}
              title={recordingStatus === "recording" ? "Stop recording" : "Push to talk"}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                recordingStatus === "recording"
                  ? "border-rose-500/60 bg-rose-500/20 text-rose-300 animate-pulse"
                  : "border-zinc-600/60 bg-zinc-900/70 text-zinc-300 hover:border-cyan-500/50"
              } ${recordingStatus === "transcribing" || recordingStatus === "speaking" ? "cursor-not-allowed opacity-40" : ""}`}
            >
              {recordingStatus === "recording" ? (
                <StopCircle className="h-5 w-5" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>

            {status === "live" ? (
              <button
                onClick={endCall}
                className="danger-glow flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white"
              >
                <StopCircle className="h-4 w-4" />
                End Call
              </button>
            ) : (
              <button
                onClick={startCall}
                disabled={status === "connecting"}
                className="glow-btn flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white"
              >
                {status === "connecting" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Phone className="h-4 w-4" />
                )}
                {status === "connecting" ? "Connecting" : "Start Outbound Call"}
              </button>
            )}
          </div>
        </div>

        {error && <p className="mx-4 mt-2 text-xs text-rose-400">{error}</p>}
        {!phoneNumber.trim() && (
          <p className="mx-4 mt-2 text-[11px] text-zinc-500">
            Click mic to push-to-talk · type a message to text chat · leave phone blank for browser voice test
          </p>
        )}
      </section>
    </div>
  );
}