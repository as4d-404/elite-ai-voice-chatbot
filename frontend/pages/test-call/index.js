import { Sparkles, ArrowLeft } from "lucide-react";
import Link from "next/link";
import LiveHarness from "../../components/LiveHarness";

export default function TestCallPage() {
  return (
    <div className="aura-bg relative min-h-screen p-4 lg:p-6">
      <div className="mx-auto flex h-[calc(100vh-2rem)] max-w-5xl flex-col gap-4 lg:h-[calc(100vh-3rem)]">
        <header className="glass flex items-center gap-3 rounded-2xl px-5 py-3.5">
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-full border border-zinc-600/50 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-purple-500/50 hover:text-purple-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </Link>
          <div className="mx-auto flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-purple-500/40 bg-purple-500/20 shadow-[0_0_18px_rgba(168,85,247,0.45)]">
              <Sparkles className="h-4 w-4 text-purple-300" />
            </span>
            <span className="text-lg font-extrabold tracking-[0.16em] text-aura">TEST CALL</span>
            <span className="ml-1 rounded-full border border-zinc-600/40 bg-zinc-900/70 px-2.5 py-0.5 text-[10px] text-zinc-400">
              browser harness · no Twilio needed
            </span>
          </div>
        </header>

        <LiveHarness />
      </div>
    </div>
  );
}