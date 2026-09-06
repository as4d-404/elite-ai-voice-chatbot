import { useState } from "react";
export const outcomes = {
  booked: { label: "Booked", color: "bg-emerald-200", badge: "bg-emerald-50 text-emerald-800" },
  callback: { label: "Callback", color: "bg-amber-200", badge: "bg-amber-50 text-amber-800" },
  not_interested: { label: "Not interested", color: "bg-rose-200", badge: "bg-rose-50 text-rose-800" },
  do_not_call: { label: "DNC", color: "bg-red-400", badge: "bg-red-50 text-red-800" },
  voicemail: { label: "Voicemail", color: "bg-violet-200", badge: "bg-violet-50 text-violet-800" },
  in_progress: { label: "In progress", color: "bg-slate-300", badge: "bg-slate-100 text-slate-700" },
};
export const prospect = lead => lead.business_name || lead.contact_name || "Unknown prospect";
export function dateLabel(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function OutcomeBadge({ outcome }) {
  const meta = outcomes[outcome];
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] ${meta?.badge || "bg-slate-100"}`}>{meta?.label || "Unknown"}</span>;
}
export function History({ leads, loading }) {
  const [copied, setCopied] = useState(null);
  const [error, setError] = useState("");
  async function copy(lead) {
    try { await navigator.clipboard.writeText(lead.transcript); setCopied(lead.id); setError(""); }
    catch { setError("Unable to copy. Select the transcript to copy it manually."); }
  }
  return <section className="overflow-hidden rounded-[28px] border border-white bg-white/80 p-5 sm:p-7"><h2 className="mb-5 text-xl">Session history</h2>{error && <p role="alert" className="text-sm text-rose-700">{error}</p>}{!leads.length && <p className="py-12 text-center text-sm text-slate-500">{loading ? "Loading sessions…" : "No sessions yet"}</p>}{leads.map(lead => <article key={lead.id} className="border-b border-slate-100 py-5 last:border-0"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">{prospect(lead)}</p><p className="mt-1 text-xs text-slate-500">{dateLabel(lead.created_at)}</p></div><OutcomeBadge outcome={lead.outcome} /></div>{lead.notes && <p className="mt-3 text-sm text-slate-600">{lead.notes}</p>}{lead.transcript && <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-violet-700">View transcript</summary><div className="rounded-2xl bg-slate-50 p-4"><button onClick={() => copy(lead)} className="mb-2 min-h-11 rounded-full border border-slate-200 px-4 text-xs hover:bg-white">{copied === lead.id ? "Copied" : "Copy transcript"}</button><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{lead.transcript}</p></div></details>}</article>)}</section>;
}
