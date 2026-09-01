import { RefreshCw, Bot, User, Clock, CheckCircle2, Loader2 } from "lucide-react";

const OUTCOME_META = {
  booked: { label: "Booked", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300", glow: true },
  callback: { label: "Callback", cls: "border-amber-500/40 bg-amber-500/15 text-amber-300", glow: false },
  not_interested: { label: "Not Interested", cls: "border-rose-500/40 bg-rose-500/15 text-rose-300", glow: false },
  voicemail: { label: "Voicemail", cls: "border-rose-500/40 bg-rose-500/15 text-rose-300", glow: false },
  do_not_call: { label: "Do Not Call", cls: "border-rose-500/50 bg-rose-500/20 text-rose-300", glow: false },
  in_progress: { label: "In Progress", cls: "border-sky-500/40 bg-sky-500/15 text-sky-300", glow: true },
};

const E164_RE = /^\+[1-9]\d{6,14}$/;

function isRealPhone(n) {
  return typeof n === "string" && E164_RE.test(n);
}

export default function LeadsPanel({ leads, loading, onRefresh, className = "" }) {
  return (
    <aside className={`glass flex min-h-0 flex-col rounded-2xl ${className}`}>
      <div className="flex items-center justify-between border-b border-purple-500/15 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Captured Leads</h2>
          <p className="text-[11px] text-zinc-500">Supabase realtime · live updates</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh leads"
          title="Refresh leads"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-purple-500/25 bg-purple-500/10 text-purple-300 transition hover:bg-purple-500/20 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-purple-200" : ""}`} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {leads.length === 0 && !loading && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <User className="h-8 w-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">No leads captured yet.</p>
            <p className="text-xs text-zinc-600">Trigger a call or use the harness to log your first one.</p>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading leads…</span>
          </div>
        )}

        {leads.map((lead) => {
          const o = OUTCOME_META[lead.outcome] || OUTCOME_META.in_progress;
          const live = lead.outcome === "in_progress";
          const name = lead.business_name || lead.contact_name || "—";
          return (
            <article key={lead.id} className="lead-hover rounded-xl border border-purple-500/15 bg-zinc-950/50 p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-purple-500/30 bg-purple-500/15 text-purple-300">
                    <User className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-100">{name}</div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">{lead.phone_number}</div>
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${o.cls} ${
                    o.glow ? "shadow-[0_0_12px_rgba(16,185,129,0.35)]" : ""
                  }`}
                >
                  {o.label}
                </span>
              </div>

              {(lead.notes || lead.contact_name || isRealPhone(lead.phone_number)) && (
                <div className="mt-3 space-y-1.5 text-xs text-zinc-400">
                  {isRealPhone(lead.phone_number) && live && (
                    <div className="flex items-center gap-1.5 text-sky-300">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 pulse-dot text-sky-400" />
                      line ringing…
                    </div>
                  )}
                  {lead.notes && (
                    <p className="line-clamp-3 leading-relaxed text-zinc-400">
                      <span className="mr-1 font-semibold text-purple-300">Learned:</span>
                      {lead.notes}
                    </p>
                  )}
                  {lead.contact_name && !lead.business_name && (
                    <p>
                      <span className="font-semibold text-zinc-500">Contact:</span> {lead.contact_name}
                    </p>
                  )}
                  {lead.followup_time && (
                    <div className="flex items-center gap-1.5 text-amber-300/90">
                      <Clock className="h-3.5 w-3.5" />
                      Follow-up: {new Date(lead.followup_time).toLocaleString()}
                    </div>
                  )}
                  <p className="flex items-center gap-1.5 text-zinc-500">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {new Date(lead.created_at).toLocaleString()}
                  </p>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-purple-500/15 px-5 py-3 text-[11px] text-zinc-500">
        <Bot className="h-3.5 w-3.5 text-purple-400" />
        Outcomes stream live from tool calls + Twilio callbacks
      </div>
    </aside>
  );
}