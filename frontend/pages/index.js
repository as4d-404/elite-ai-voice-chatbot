import { useEffect, useState } from "react";
import {
  Sparkles,
  Activity,
  ListFilter,
  MessageSquare,
  Settings,
  Bot,
  User,
  Database,
  Clock,
  CheckCircle2,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import LiveHarness from "../components/LiveHarness";
import LeadsPanel from "../components/LeadsPanel";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "";

const NAV = [
  { id: "harness", label: "Live Call Harness", icon: Activity },
  { id: "leads", label: "Captured Leads", icon: ListFilter },
  { id: "logs", label: "Call Logs & Transcripts", icon: MessageSquare },
  { id: "settings", label: "System Settings", icon: Settings },
];

const OUTCOME_DOT = {
  booked: "bg-emerald-400",
  callback: "bg-amber-400",
  not_interested: "bg-rose-400",
  voicemail: "bg-rose-400",
  do_not_call: "bg-rose-400",
  in_progress: "bg-sky-400",
};

export default function CommandCenter() {
  const [view, setView] = useState("harness");
  const [leads, setLeads] = useState([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [backend, setBackend] = useState("checking");
  const [liveState, setLiveState] = useState("idle");

  useEffect(() => {
    let mounted = true;
    async function ping() {
      try {
        const r = await fetch(`${BACKEND_URL}/health`, { cache: "no-store" });
        if (mounted) setBackend(r.ok ? "up" : "down");
      } catch {
        if (mounted) setBackend("down");
      }
    }
    ping();
    const t = setInterval(ping, 15000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);

  const fetchLeads = async () => {
    try {
      const { data } = await supabase
        .from("leads")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(60);
      if (data) setLeads(data);
    } finally {
      setLeadsLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
    const channel = supabase
      .channel("leads-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => fetchLeads())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  const handleLiveState = (s) => {
    setLiveState(s);
    if (s === "live") setBackend("up");
  };

  return (
    <div className="aura-bg relative min-h-screen p-4 lg:p-5">
      <div className="mx-auto flex max-w-[1760px] flex-col gap-4 lg:flex-row lg:items-stretch">
        <Sidebar view={view} setView={setView} backend={backend} liveState={liveState} />

        <main className="flex min-w-0 flex-1 flex-col gap-4">
          {view === "harness" && <LiveHarness onCallStateChange={handleLiveState} />}
          {view === "leads" && (
            <LeadsPanel leads={leads} loading={leadsLoading} onRefresh={fetchLeads} className="h-full" />
          )}
          {view === "logs" && <TranscriptsView leads={leads} loading={leadsLoading} onRefresh={fetchLeads} />}
          {view === "settings" && <SettingsView backend={backend} />}
        </main>

        <div className="h-[540px] lg:h-auto lg:w-[400px] lg:shrink-0">
          <LeadsPanel leads={leads} loading={leadsLoading} onRefresh={fetchLeads} className="h-full" />
        </div>
      </div>
    </div>
  );
}

function Sidebar({ view, setView, backend, liveState }) {
  return (
    <header className="glass flex flex-col gap-2 lg:w-64 lg:shrink-0">
      <div className="flex items-center gap-2 px-5 pt-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-purple-500/40 bg-purple-500/20 shadow-[0_0_18px_rgba(168,85,247,0.45)]">
          <Sparkles className="h-4.5 w-4.5 text-purple-300" />
        </span>
        <span className="text-xl font-extrabold tracking-[0.18em] text-aura">AIAURA</span>
      </div>
      <div className="px-5 pb-4 text-[11px] text-zinc-500">Elite AI · Outbound Voice Agent</div>

      <nav className="flex gap-1.5 overflow-x-auto px-3 lg:flex-col lg:overflow-visible">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              aria-current={active ? "page" : undefined}
              className={`relative flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium transition lg:w-full ${
                active
                  ? "border border-purple-500/40 bg-purple-500/15 text-purple-200 shadow-[0_0_16px_rgba(168,85,247,0.25)]"
                  : "border border-transparent text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-gradient-to-b from-purple-300 to-purple-600 lg:left-auto lg:right-1" />
              )}
              <Icon className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">{item.label}</span>
              {item.id === "leads" && liveState === "live" && (
                <span className="ml-auto inline-block h-2 w-2 rounded-full bg-emerald-400 pulse-dot text-emerald-400" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-purple-500/15 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${backend === "up" ? "bg-emerald-400 pulse-dot text-emerald-400" : backend === "down" ? "bg-rose-500" : "bg-zinc-500 animate-pulse"}`} />
          <span className="text-xs font-medium text-zinc-300">FastAPI + Gemini Live:</span>
        </div>
        <span className={`text-[11px] ${backend === "up" ? "text-emerald-300" : "text-rose-300"}`}>
          {backend === "up" ? "Connected" : backend === "down" ? "Offline — start uvicorn" : "Checking…"}
        </span>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
          <Database className="h-3 w-3" />
          Supabase realtime · live
        </div>
      </div>
    </header>
  );
}

function TranscriptsView({ leads, loading, onRefresh }) {
  const live = leads.filter((l) => l.outcome === "in_progress").length;
  const booked = leads.filter((l) => l.outcome === "booked").length;
  const ended = leads.length - live;
  return (
    <div className="glass flex min-h-0 flex-1 flex-col rounded-2xl">
      <div className="flex items-center justify-between border-b border-purple-500/15 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Call Logs &amp; Transcripts</h2>
          <p className="text-[11px] text-zinc-500">
            {leads.length} calls · {live} live · {booked} booked · {ended} ended
          </p>
        </div>
        <button
          onClick={onRefresh}
          aria-label="Refresh logs"
          className="flex h-9 items-center gap-2 rounded-full border border-purple-500/25 bg-purple-500/10 px-3 text-xs text-purple-300 transition hover:bg-purple-500/20"
        >
          <span className={`${loading ? "animate-spin" : ""}`}>⟳</span> Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        )}
        {!loading && leads.length === 0 && (
          <div className="py-16 text-center text-sm text-zinc-500">No call logs yet.</div>
        )}
        {leads.map((lead) => (
          <article key={lead.id} className="lead-hover rounded-xl border border-purple-500/15 bg-zinc-950/50 p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-purple-500/30 bg-purple-500/15 text-purple-300">
                <User className="h-3.5 w-3.5" />
              </span>
              <span className="text-sm font-medium text-zinc-100">
                {lead.business_name || lead.contact_name || "—"}
              </span>
              <span className="rounded-full bg-zinc-900/80 px-2.5 py-0.5 font-mono text-[11px] text-zinc-500">
                {lead.phone_number}
              </span>
              <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span className={`inline-block h-2 w-2 rounded-full ${OUTCOME_DOT[lead.outcome] || "bg-zinc-500"}`} />
                {lead.outcome}
              </span>
            </div>
            <div className="mt-3 space-y-1.5 text-xs text-zinc-400">
              {lead.notes && (
                <p className="leading-relaxed">
                  <span className="font-semibold text-purple-300">Summary:</span> {lead.notes}
                </p>
              )}
              {lead.transcript ? (
                <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 leading-relaxed">{lead.transcript}</p>
              ) : (
                <p className="text-zinc-600">
                  No transcript captured for this leg (transcripts appear for live browser-harness turns).
                </p>
              )}
              {lead.followup_time && (
                <div className="flex items-center gap-1.5 text-amber-300/90">
                  <Clock className="h-3.5 w-3.5" />
                  Follow-up: {new Date(lead.followup_time).toLocaleString()}
                </div>
              )}
              <div className="flex items-center gap-1.5 text-zinc-500">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {new Date(lead.created_at).toLocaleString()}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function SettingsView({ backend }) {
  const items = [
    { k: "Supabase URL", v: process.env.NEXT_PUBLIC_SUPABASE_URL || "—", ok: !!process.env.NEXT_PUBLIC_SUPABASE_URL },
    { k: "Supabase anon key", v: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "configured" : "—", ok: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
    { k: "Backend REST", v: BACKEND_URL || "—", ok: !!BACKEND_URL },
    { k: "Harness WebSocket", v: `${(BACKEND_URL || "").replace(/^http/, "ws")}/ws/test-call`, ok: !!BACKEND_URL },
  ];
  return (
    <div className="glass flex min-h-0 flex-1 flex-col rounded-2xl p-5">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">System Settings</h2>
        <p className="text-[11px] text-zinc-500">Read-only status from the running environment.</p>
      </div>

      <div className="mt-5 space-y-2">
        {items.map((it) => (
          <div key={it.k} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-4 py-3">
            <span className="text-sm text-zinc-300">{it.k}</span>
            <span className={`max-w-[55%] truncate font-mono text-xs ${it.ok ? "text-purple-300" : "text-zinc-600"}`}>
              {it.v}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-4 py-3">
          <span className="text-sm text-zinc-300">Backend health</span>
          <span className={`inline-flex items-center gap-2 text-xs font-medium ${backend === "up" ? "text-emerald-300" : "text-rose-300"}`}>
            <span className={`h-2 w-2 rounded-full ${backend === "up" ? "bg-emerald-400 pulse-dot text-emerald-400" : "bg-rose-500"}`} />
            {backend === "up" ? "Healthy" : "Unreachable"}
          </span>
        </div>
      </div>

      <div className="mt-5 flex items-start gap-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 text-xs text-zinc-400">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-purple-300" />
        <p>
          Do-not-call is honored in-call: the agent apologizes and logs{" "}
          <span className="text-rose-300">do_not_call</span> immediately. Phone numbers are validated as
          E.164 on both client and backend before dialing.
        </p>
      </div>

      <div className="mt-5 flex items-start gap-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 text-xs text-zinc-400">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-purple-300" />
        <p>
          Voice layer runs on <span className="text-purple-300">Gemini Live</span> (Google AI Studio). OpenAI
          Agents SDK &amp; Claude Agent SDK clients are initialized in the backend for agent-logic paths.
          Telephony callbacks and outcome logging are handled by FastAPI + Supabase.
        </p>
      </div>
    </div>
  );
}