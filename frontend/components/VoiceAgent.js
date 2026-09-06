import { useEffect, useRef, useState } from "react";
import { AudioWaveform, Mic, Send, Square } from "lucide-react";

const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
const stateColors = { Ready: "bg-slate-100 text-slate-700", Recording: "bg-rose-100 text-rose-700", Transcribing: "bg-cyan-100 text-cyan-800", Thinking: "bg-violet-100 text-violet-700", Speaking: "bg-cyan-100 text-cyan-800" };
export function StatePill({ state = "Ready" }) {
  return <span role="status" className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs ${stateColors[state]}`}><span className={`h-1.5 w-1.5 rounded-full bg-current ${state !== "Ready" ? "motion-safe:animate-pulse" : ""}`} />{state}</span>;
}
export function durationLabel(seconds) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export default function VoiceAgent({ onSessionEnded, onSessionChange, onStateChange }) {
  const [state, setState] = useState("Ready");
  const [active, setActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [needsSave, setNeedsSave] = useState(false);
  const [bubbles, setBubbles] = useState([]);
  const [textInput, setTextInput] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [seconds, setSeconds] = useState(0);
  const sessionIdRef = useRef(null);
  const stateRef = useRef("Ready");
  const generation = useRef(0);
  const audioRef = useRef(null);
  const urlRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const controllerRef = useRef(null);
  const chatPendingRef = useRef(null);
  const savingRef = useRef(false);
  const needsSaveRef = useRef(false);
  const startingMicRef = useRef(false);
  const startedAtRef = useRef(null);
  const scrollRef = useRef(null);
  const voiceActiveRef = useRef(false);
  const openingShownRef = useRef(null);
  const analysisRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const maxRecordingTimerRef = useRef(null);
  const autoListenTimerRef = useRef(null);

  function transition(next) { stateRef.current = next; setState(next); }
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);
  useEffect(() => {
    if (!active) { setSeconds(0); return; }
    const tick = () => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [bubbles]);
  useEffect(() => () => { voiceActiveRef.current = false; invalidate(); stopRecording(true); }, []);

  function audioElement() {
    if (!audioRef.current) { audioRef.current = new Audio(); audioRef.current.preload = "auto"; }
    return audioRef.current;
  }
  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.onplaying = null;
      audioRef.current.pause(); audioRef.current.removeAttribute("src"); audioRef.current.load();
    }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
  }
  function invalidate() {
    generation.current += 1;
    clearTimeout(autoListenTimerRef.current); autoListenTimerRef.current = null;
    controllerRef.current?.abort(); controllerRef.current = null;
    stopAudio();
    return generation.current;
  }
  function cleanupAnalysis() {
    clearInterval(silenceTimerRef.current); silenceTimerRef.current = null;
    clearTimeout(maxRecordingTimerRef.current); maxRecordingTimerRef.current = null;
    const analysis = analysisRef.current;
    analysisRef.current = null;
    if (analysis) {
      analysis.source?.disconnect(); analysis.analyser?.disconnect();
      void analysis.context.close().catch(err => console.error("Audio analysis cleanup failed", err));
    }
  }
  function stopRecording(discard) {
    cleanupAnalysis();
    const recorder = recorderRef.current;
    if (recorder) {
      if (discard) { recorder.onstop = null; recorder.ondataavailable = null; }
      if (recorder.state !== "inactive") recorder.stop();
    }
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null; recorderRef.current = null;
  }
  function ensureSession() {
    if (savingRef.current || needsSaveRef.current) return;
    audioElement();
    if (!sessionIdRef.current) {
      sessionIdRef.current = crypto.randomUUID(); setBubbles([]); setNotice("");
    }
    if (!startedAtRef.current) {
      startedAtRef.current = Date.now(); setActive(true); onSessionChange?.(startedAtRef.current);
    }
    return sessionIdRef.current;
  }
  async function startSession() {
    if (savingRef.current || needsSaveRef.current || chatPendingRef.current || voiceActiveRef.current) return;
    const session_id = ensureSession();
    if (!session_id) return;
    voiceActiveRef.current = true;
    const token = invalidate(); setError(""); transition("Thinking");
    // Let the start request finish before ending, just like an ordinary chat turn.
    const pending = request("/api/chat/start", { session_id }).then(response => response.json());
    chatPendingRef.current = pending;
    try {
      const data = await pending;
      if (token !== generation.current) return;
      chatPendingRef.current = null;
      if (data.reply) {
        if (openingShownRef.current !== session_id) {
          bubble("agent", data.reply); openingShownRef.current = session_id;
        }
        await speakAgentReply(data.reply, token);
      } else {
        transition("Ready"); listenAgain(token);
      }
    } catch (err) {
      if (token === generation.current) {
        console.error("Session start failed", err);
        voiceActiveRef.current = false; startedAtRef.current = null;
        setActive(false); onSessionChange?.(null); transition("Ready");
        setError("Unable to start Maya. Please try again.");
      }
    } finally { if (chatPendingRef.current === pending) chatPendingRef.current = null; }
  }
  function listenAgain(token) {
    clearTimeout(autoListenTimerRef.current);
    if (!voiceActiveRef.current || token !== generation.current) return;
    autoListenTimerRef.current = setTimeout(() => {
      autoListenTimerRef.current = null;
      if (voiceActiveRef.current && token === generation.current) void startListening();
    }, 100);
  }
  function bubble(who, text) { setBubbles(prev => [...prev, { id: crypto.randomUUID(), who, text }]); }
  async function request(path, body, signal) {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST", headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body), signal,
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response;
  }
  async function speakAgentReply(reply, token) {
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const response = await request("/api/speak", { text: reply }, controller.signal);
      const blob = await response.blob();
      if (token !== generation.current) return;
      if (!blob.size) throw new Error("Empty audio");
      const audio = audioElement();
      urlRef.current = URL.createObjectURL(blob); audio.src = urlRef.current;
      audio.onplaying = () => { if (token === generation.current) transition("Speaking"); };
      audio.onended = () => { if (token === generation.current) { stopAudio(); transition("Ready"); listenAgain(token); } };
      audio.onerror = () => { if (token === generation.current) { console.error("Audio playback failed"); setError("Voice playback unavailable. You can keep typing."); stopAudio(); transition("Ready"); } };
      await audio.play();
    } catch (err) {
      if (token !== generation.current) return;
      console.error("Voice playback failed", err); setError("Voice playback unavailable. You can keep typing."); stopAudio(); transition("Ready");
    }
  }
  // Typed and transcribed turns enter here once, with explicit text (never stale input state).
  async function sendMessage(text, source = "typed") {
    const message = text.trim();
    if (!message || savingRef.current || needsSaveRef.current || chatPendingRef.current) return;
    if (source === "typed" && ["Recording", "Transcribing"].includes(stateRef.current)) return;
    const session_id = ensureSession();
    if (!session_id) return;
    const token = invalidate(); setError(""); setNotice("");
    bubble("prospect", message); transition("Thinking");
    // Do not abort chat: the server must finish committing this turn before finalization.
    const pending = request("/api/chat", { session_id, message }).then(response => response.json());
    chatPendingRef.current = pending;
    try {
      const data = await pending;
      if (token !== generation.current) return;
      bubble("agent", data.reply);
      chatPendingRef.current = null;
      await speakAgentReply(data.reply, token);
    } catch (err) {
      if (token === generation.current) { console.error("Chat failed", err); setError("Unable to reach Maya. Please try again."); transition("Ready"); }
    } finally { if (chatPendingRef.current === pending) chatPendingRef.current = null; }
  }
  function handleSendText(event) {
    event?.preventDefault();
    if (!textInput.trim() || chatPendingRef.current) return;
    const text = textInput; setTextInput(""); void sendMessage(text, "typed");
  }
  function finishRecording() {
    if (!recorderRef.current || recorderRef.current.state !== "recording") return;
    transition("Transcribing"); stopRecording(false);
  }
  function toggleRecording() {
    if (stateRef.current === "Recording") { finishRecording(); return; }
    if (savingRef.current || needsSaveRef.current || chatPendingRef.current || stateRef.current === "Transcribing") return;
    voiceActiveRef.current = true;
    void startListening();
  }
  async function startListening() {
    if (!voiceActiveRef.current || savingRef.current || needsSaveRef.current || startingMicRef.current || recorderRef.current || chatPendingRef.current || stateRef.current === "Transcribing") return;
    // Invalidate and stop TTS synchronously, before asking for microphone access.
    const token = invalidate(); audioElement(); setError(""); startingMicRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (token !== generation.current || !voiceActiveRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = []; recorderRef.current = recorder;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        if (recorderRef.current === recorder) stopRecording(false);
        stream.getTracks().forEach(track => track.stop());
        if (token === generation.current && voiceActiveRef.current) void processVoiceAudio(new Blob(chunks, { type: recorder.mimeType }), token);
      };
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContextClass();
      analysisRef.current = { context, analyser: null, source: null };
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      analysisRef.current.analyser = analyser;
      const source = context.createMediaStreamSource(stream);
      analysisRef.current.source = source;
      source.connect(analyser); // Never connect microphone monitoring to the speakers.
      analysisRef.current = { context, analyser, source };
      await context.resume();
      if (token !== generation.current || !voiceActiveRef.current) return;
      ensureSession(); recorder.start(); transition("Recording");
      const samples = new Float32Array(analyser.fftSize);
      let speechDetected = false;
      let speechStartedAt = null;
      let lastSpeechAt = 0;
      silenceTimerRef.current = setInterval(() => {
        if (token !== generation.current || recorderRef.current !== recorder) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const now = performance.now();
        if (rms >= 0.015) {
          if (speechStartedAt === null) speechStartedAt = now;
          if (now - speechStartedAt >= 120) speechDetected = true;
          lastSpeechAt = now;
        } else {
          speechStartedAt = null;
          if (speechDetected && now - lastSpeechAt >= 1000) finishRecording();
        }
      }, 50);
      maxRecordingTimerRef.current = setTimeout(() => {
        if (token !== generation.current || recorderRef.current !== recorder) return;
        if (speechDetected) finishRecording();
        else {
          // Discard silence rather than transcribing it or inventing a user turn.
          stopRecording(true); transition("Ready"); listenAgain(token);
        }
      }, 15000);
    } catch (err) {
      if (token === generation.current) { stopRecording(true); console.error("Microphone unavailable", err); setError("Microphone unavailable. Check permission or type a message."); transition("Ready"); }
    } finally { startingMicRef.current = false; }
  }
  async function processVoiceAudio(blob, token) {
    transition("Transcribing");
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const form = new FormData(); form.append("file", blob, blob.type.includes("mp4") ? "recording.mp4" : "recording.webm");
      const response = await request("/api/transcribe", form, controller.signal);
      const data = await response.json();
      if (token !== generation.current) return;
      if (!data.text?.trim()) { setError("No speech detected. Try again."); transition("Ready"); listenAgain(token); return; }
      await sendMessage(data.text, "voice");
    } catch (err) {
      if (token === generation.current) { console.error("Transcription failed", err); setError("Unable to transcribe. Please try again."); transition("Ready"); }
    }
  }
  async function endSession() {
    if (savingRef.current || !sessionIdRef.current) return;
    savingRef.current = true; voiceActiveRef.current = false; startedAtRef.current = null; setSaving(true); invalidate(); stopRecording(true); transition("Ready");
    setActive(false); onSessionChange?.(null); setError("");
    try {
      await chatPendingRef.current?.catch(() => {});
      // A session with no submitted turn has nothing to persist.
      if (bubbles.length) {
        await request("/api/chat/end", { session_id: sessionIdRef.current });
        setNotice("Session saved.");
        await onSessionEnded?.();
      } else setNotice("Session ended.");
      sessionIdRef.current = null; needsSaveRef.current = false; setNeedsSave(false);
    } catch (err) {
      console.error("Session save failed", err); needsSaveRef.current = true; setNeedsSave(true); setError("Session could not be saved. Retry to keep your conversation.");
    } finally { savingRef.current = false; setSaving(false); }
  }
  const blocked = saving || needsSave || state === "Recording" || state === "Transcribing" || (state === "Thinking" && !!chatPendingRef.current);
  const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40";
  return <section className="flex h-[calc(100dvh-300px)] min-h-[420px] flex-col overflow-hidden rounded-[28px] border border-white bg-white/80 shadow-sm sm:h-[650px]">
    <header className="flex items-center justify-between gap-3 border-b border-slate-100 p-4 sm:px-7 sm:py-5">
      <div className="flex items-center gap-3"><AudioWaveform className="h-9 w-9 rounded-xl bg-violet-100 p-2 text-violet-600" /><div><h2 className="font-medium">Maya</h2><p className="text-xs text-slate-500">Voice Agent{active ? ` · ${durationLabel(seconds)}` : ""}</p></div></div><StatePill state={state} />
    </header>
    <div ref={scrollRef} role="log" aria-label="Conversation" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-7">
      {!bubbles.length && <div className="flex h-full flex-col items-center justify-center gap-4 text-center"><AudioWaveform className="h-16 w-16 rounded-3xl bg-violet-50 p-4 text-violet-400" /><p className="text-lg">Ready when you are.</p><p className="text-sm text-slate-500">Type a message or start a voice session.</p></div>}
      {bubbles.map(b => <div key={b.id} className={`flex ${b.who === "agent" ? "justify-start" : "justify-end"}`}><div className={`max-w-[90%] rounded-[22px] border px-4 py-3 sm:max-w-[75%] sm:px-5 ${b.who === "agent" ? "border-violet-200/60 bg-gradient-to-br from-violet-50 to-indigo-100/70" : "border-cyan-200/60 bg-gradient-to-br from-cyan-50 to-sky-100/70"}`}><p className={`mb-1 text-[10px] font-semibold tracking-widest ${b.who === "agent" ? "text-violet-700" : "text-cyan-800"}`}>{b.who === "agent" ? "MAYA" : "YOU"}</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{b.text}</p></div></div>)}
    </div>
    <div className="border-t border-slate-100 bg-white p-4 sm:p-5">
      <form onSubmit={handleSendText} className="flex gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-1.5"><input aria-label="Type a message" placeholder="Type a message…" value={textInput} onChange={e => setTextInput(e.target.value)} disabled={blocked} className="min-w-0 flex-1 rounded-xl bg-transparent px-3 text-base outline-none focus:ring-2 focus:ring-violet-300 disabled:opacity-50" /><button type="submit" aria-label="Send message" disabled={blocked || !textInput.trim()} className={`${button} bg-[#7C6CF2] text-white hover:bg-[#6D5CE7]`}><Send size={18} /></button></form>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] text-slate-500">{state === "Recording" ? "Listening — speak naturally" : "Enter → send"}</span><div className="flex gap-2"><button aria-label={state === "Recording" ? "Stop recording" : "Start recording"} onClick={toggleRecording} disabled={saving || needsSave || state === "Transcribing" || !!chatPendingRef.current} className={`${button} ${state === "Recording" ? "bg-rose-100 text-rose-700" : "bg-slate-100"}`}>{state === "Recording" ? <Square size={18} /> : <Mic size={18} />}</button>{active || needsSave || saving ? <button onClick={endSession} disabled={saving} className={`${button} bg-slate-900 text-white hover:bg-slate-700`}>{saving ? "Saving…" : needsSave ? "Retry Save" : "End Session"}</button> : <button onClick={startSession} className={`${button} bg-slate-900 text-white hover:bg-slate-700`}>Start Voice Session</button>}</div></div>
      {error && <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p>}{notice && <p role="status" className="mt-3 text-xs text-slate-500">{notice}</p>}
    </div>
  </section>;
}
