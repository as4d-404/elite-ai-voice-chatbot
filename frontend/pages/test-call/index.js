import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import LiveHarness from "../../components/LiveHarness";
import Image from "next/image";

export default function TestCallPage() {
  return (
    <div className="aura-bg min-h-screen p-4 lg:p-6">
      <div className="mx-auto flex h-[calc(100vh-2rem)] max-w-5xl flex-col gap-4 lg:h-[calc(100vh-3rem)]">
        <header className="glass flex items-center gap-3 rounded-2xl px-5 py-3.5">
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-full border border-zinc-600/50 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-cyan-500/50 hover:text-cyan-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </Link>
          <div className="mx-auto flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10">
              <Image
                src="/elite-ai-logo.svg"
                alt="Elite AI"
                width={32}
                height={32}
                className="h-7 w-7 object-contain"
              />
            </span>
            <span className="text-lg font-extrabold tracking-[0.16em] text-elite">VOICE AGENT</span>
            <span className="ml-1 rounded-full border border-zinc-600/40 bg-zinc-900/70 px-2.5 py-0.5 text-[10px] text-zinc-400">
              browser test · no Twilio needed
            </span>
          </div>
        </header>

        <LiveHarness />
      </div>
    </div>
  );
}