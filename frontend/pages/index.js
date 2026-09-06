import { useCallback, useEffect, useRef, useState } from "react";
import Head from "next/head";
import { Settings } from "lucide-react";
import { supabase } from "../lib/supabase";
import VoiceAgent from "../components/VoiceAgent";
import LeadsPanel from "../components/LeadsPanel";
import Overview from "../components/Overview";
import { History } from "../components/LeadViews";

export default function IndexPage({ initialView = "overview" }) {
  const [view, setView] = useState(initialView);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState("");
  const [voiceState, setVoiceState] = useState("Ready");
  const [startedAt, setStartedAt] = useState(null);
  const [seconds, setSeconds] = useState(0);
  const mounted = useRef(false);
  const fetchVersion = useRef(0);
  const fetchLeads = useCallback(async () => {
    const version = ++fetchVersion.current;
    setLoading(true);
    try {
      if (!supabase) throw new Error("Lead client unavailable");
      // Paginate so dashboard totals are not silently limited to the first 60/1000 rows.
      const all = []; let offset = 0;
      while (true) {
        const { data, error } = await supabase.from("leads").select("*").order("created_at", { ascending: false }).order("id").range(offset, offset + 999);
        if (error) throw error;
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
        offset += 1000;
      }
      if (mounted.current && version === fetchVersion.current) { setLeads(all); setAvailable(true); setError(""); }
    } catch {
      if (mounted.current && version === fetchVersion.current) { setAvailable(false); setError("Leads could not be loaded. Please refresh to try again."); }
    } finally { if (mounted.current && version === fetchVersion.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; void fetchLeads();
    // Explicit fetch/refetch is sufficient; Realtime is deliberately optional and unused.
    return () => { mounted.current = false; fetchVersion.current += 1; };
  }, [fetchLeads]);
  useEffect(() => {
    if (!startedAt) { setSeconds(0); return; }
    const tick = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [startedAt]);
  return <>
    <Head><title>Elite AI · Voice workspace</title><meta name="description" content="Your Elite AI voice workspace. Conversations, leads, and follow-ups."/><link rel="icon" href="/elite-ai-mark.svg"/></Head>
    <div className="min-h-screen bg-[#dfe5ec] p-2 font-sans text-[#292b35] antialiased sm:p-5 lg:p-7">
      <div className="mx-auto min-h-[calc(100vh-56px)] max-w-[1680px] rounded-[26px] border border-white/80 bg-[#f3f4f9] p-4 shadow-[0_20px_80px_rgba(55,67,91,0.08)] sm:rounded-[40px] sm:p-7 lg:px-10 lg:py-7">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/70 pb-6 lg:mb-10"><button onClick={() => setView("overview")} aria-label="Elite AI overview" className="flex min-h-11 items-center gap-2.5 text-xl font-semibold tracking-tight"><svg aria-hidden="true" viewBox="0 0 32 32" className="h-8 w-8"><path d="M6 8h20l-5 6H6zM6 18h15l5 6H6z" fill="#7C6CF2"/></svg>Elite AI<span className="mb-2 h-1 w-1 rounded-full bg-violet-500"/></button><nav aria-label="Main navigation" className="order-3 flex w-full items-center justify-center gap-1 rounded-full border border-slate-200/70 p-1 sm:w-auto lg:order-none">{["overview", "voice", "leads", "history"].map(item => <button key={item} aria-current={view === item ? "page" : undefined} onClick={() => setView(item)} className={`min-h-11 flex-1 rounded-full px-3 text-xs capitalize transition duration-200 sm:px-6 ${view === item ? "bg-[#292b32] text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}>{item}</button>)}</nav><button onClick={() => setView("settings")} aria-label="Settings" aria-current={view === "settings" ? "page" : undefined} className={`flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 transition hover:bg-white ${view === "settings" ? "bg-white text-violet-700" : ""}`}><Settings size={18}/></button></header>
        <main>
          {error && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-amber-50 px-4 py-2 text-xs text-amber-900"><span>{error}</span><button onClick={fetchLeads} disabled={loading} className="min-h-11 px-3 underline">Refresh</button></div>}
          {view === "overview" && <Overview leads={leads} available={available} voiceState={voiceState} startedAt={startedAt} seconds={seconds} onVoice={() => setView("voice")} />}
          {/* Keep the working session mounted when navigating to metrics or leads. */}
          <div hidden={view !== "voice"}><h1 className="mb-6 text-3xl tracking-tight sm:text-4xl">Voice session</h1><VoiceAgent onSessionEnded={fetchLeads} onSessionChange={setStartedAt} onStateChange={setVoiceState}/></div>
          {view === "leads" && <><h1 className="mb-6 text-4xl tracking-tight">Leads</h1><LeadsPanel leads={leads} loading={loading} onRefresh={fetchLeads}/></>}
          {view === "history" && <><h1 className="mb-6 text-4xl tracking-tight">History</h1><History leads={leads} loading={loading}/></>}
          {view === "settings" && <><h1 className="mb-6 text-4xl tracking-tight">Settings</h1><section className="rounded-[28px] border border-white bg-white/80 p-7"><h2 className="text-lg">Your workspace</h2><p className="mt-3 text-sm text-slate-500">No preferences to configure yet.</p></section></>}
        </main><footer className="mt-8 text-[10px] tracking-widest text-slate-400">ELITE AI · VOICE WORKSPACE</footer>
      </div>
    </div>
  </>;
}
