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
} from "lucide-react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;
const WS_URL = `${(BACKEND_URL || "").replace(/^http/, "ws").replace(/\/$/, "")}/ws/test-call`;
const E164 = /^\+[1-9]\d{6,14}$/;

const STATUS_META = {
  idle: {
    label: "Idle",
    pill: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
    dot: "bg-zinc-500",
  },
  connecting: {
    label: "Connecting...",
    pill: "border-purple-500/40 bg-purple-500/10 text-purple-300",
    dot: "bg-purple-400 animate-pulse",
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
  const [prospectName, setProspectName] = useState("Jordan");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [bubbles, setBubbles] = useState([]);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState(Array(24).fill(0));
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [error, setError] = useState("");
  const [outbound, setOutbound] = useState(null);

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

  const setStatusNow = useCallback((s) => {
    statusRef.current = s;
    setStatus(s);
    if (onCallStateChange) onCallStateChange(s);
  }, [onCallStateChange]);

  const appendBubble = useCallback((who, text) => {
    setBubbles((prev) => [...prev.slice(-200), { id: ++bubbleSeq, who, text, time: now() }]);
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
    testIdRef.current = `browser-test-${Date.now()}`;
    appendBubble("system", "Opening audio harness…");

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

    ws.addEventListener("open", () => {
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
        appendBubble("agent", msg.text);
        setAgentSpeaking(true);
        if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
        speakTimerRef.current = setTimeout(() => setAgentSpeaking(false), 1400);
      } else if (msg.type === "user_transcript") {
        appendBubble("prospect", msg.text);
      } else if (msg.type === "interrupted") {
        setAgentSpeaking(false);
        appendBubble("system", "Interrupted — you spoke first.");
      }
    });

    ws.addEventListener("close", () => {
      setAgentSpeaking(false);
      if (statusRef.current !== "idle" && statusRef.current !== "ended") {
        setStatusNow("ended");
        appendBubble("system", "Connection closed.");
      }
    });

    ws.addEventListener("error", () => {
      setStatusNow("ended");
      appendBubble("system", "WebSocket error — check backend is running.");
    });
  }

  async function endCall() {
    cleanupStreams();
    setAgentSpeaking(false);
    setLevels(Array(24).fill(0));
    setStatusNow("ended");
    appendBubble("system", "Call ended.");
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

  function handleSendText() {
    const t = textInput.trim();
    if (!t || wsRef.current?.readyState !== WebSocket.OPEN) return;
    appendBubble("prospect", t);
    wsRef.current.send(JSON.stringify({ type: "text", text: t }));
    setTextInput("");
  }

  const meta = STATUS_META[status] || STATUS_META.idle;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="glass-strong flex flex-col gap-3 rounded-2xl px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-purple-400" />
          <div>
            <div className="text-sm font-semibold text-zinc-100">
              Lead: <span className="text-aura">{prospectName || "Unnamed prospect"}</span>
            </div>
            <div className="text-xs text-zinc-500">Home Service Pro · outbound desk</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {outbound ? (
            <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1 text-xs text-purple-300">
              Twilio dialing {outbound.phone}
            </span>
          ) : null}
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium ${meta.pill}`}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${meta.dot} ${meta.ring ? "pulse-dot text-emerald-400" : ""}`}
            />
            {meta.label}
          </span>
        </div>
      </header>

      <section className="glass-strong flex min-h-0 flex-1 flex-col rounded-2xl">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {bubbles.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Bot className="h-12 w-12 text-purple-500/50" />
              <p className="max-w-sm text-sm text-zinc-500">
                Quiet on the line. Press{" "}
                <span className="font-medium text-purple-300">Start Outbound Call</span> to open a live
                session — or type a reply below to test silently.
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
                      ? "border-purple-500/40 bg-purple-500/20 text-purple-300"
                      : "border-indigo-500/40 bg-indigo-500/20 text-indigo-300"
                  }`}
                >
                  {isAgent ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
                </div>
                <div
                  className={`max-w-[78%] rounded-2xl px-4 py-3 ${
                    isAgent
                      ? "border border-purple-500/25 bg-zinc-900/90 text-zinc-100"
                      : "bg-gradient-to-br from-purple-600/85 to-indigo-600/85 text-white"
                  }`}
                >
                  {isAgent && (
                    <div className="mb-1 flex items-center justify-between gap-3">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-purple-300">
                        Jordan · AI
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
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-purple-500/40 bg-purple-500/20 text-purple-300">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-2 rounded-full border border-purple-500/25 bg-zinc-900/90 px-4 py-2">
                <span className="speak-dots">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="text-xs text-purple-300">Jordan speaking…</span>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-purple-500/15 p-3">
          <div className="flex gap-2">
            <input
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendText()}
              placeholder={
                status === "live"
                  ? "Type what you'd say and press Enter (or use the mic)…"
                  : "Start the call first, or send a silent text turn…"
              }
              className="min-w-0 flex-1 rounded-full border border-zinc-700/60 bg-zinc-900/70 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-purple-500/60"
            />
            <button
              onClick={handleSendText}
              aria-label="Send text turn"
              className="flex items-center justify-center rounded-full border border-purple-500/30 bg-purple-500/10 px-4 text-purple-300 transition hover:bg-purple-500/20"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>

      <footer className="glass-strong rounded-2xl px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-[220px] flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <input
              aria-label="Prospect name"
              value={prospectName}
              onChange={(e) => setProspectName(e.target.value)}
              placeholder="Prospect name (e.g. Jordan's Plumbing)"
              className="min-w-0 flex-1 rounded-lg border border-zinc-700/60 bg-zinc-900/70 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-purple-500/60"
            />
            <input
              aria-label="Phone number to call"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+15551234567"
              inputMode="tel"
              className="min-w-0 flex-1 rounded-lg border border-zinc-700/60 bg-zinc-900/70 px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-purple-500/60"
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="wave-track" aria-hidden="true">
              {levels.map((l, i) => (
                <span key={i} style={{ height: `${Math.round((l || 0.04) * 22)}px` }} />
              ))}
            </div>

            <button
              onClick={toggleMute}
              disabled={status !== "live"}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              title={muted ? "Unmute" : "Mute"}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                muted
                  ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
                  : "border-zinc-600/60 bg-zinc-900/70 text-zinc-300 hover:border-purple-500/50"
              } ${status !== "live" ? "cursor-not-allowed opacity-40" : ""}`}
            >
              {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
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

        {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
        {!phoneNumber.trim() && (
          <p className="mt-2 text-[11px] text-zinc-500">
            No phone entered — opens the browser audio harness (same agent, no Twilio). Enter an E.164
            number to also dial it for real.
          </p>
        )}
      </footer>
    </div>
  );
}