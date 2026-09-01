// Shared voice-call chrome: the waveform/mic/stop icons and the live-duration
// ticker, used by both the composer button (app.tsx) and the on-page call
// console (sessions-panel.tsx) so every surface speaks the same visual
// language — neutral chrome, activity color only on the waveform.
import { useEffect, useState, useSyncExternalStore } from "react";
import { voiceAgent } from "./voice-agent";
import { cn } from "@/lib/utils";

export function WaveformIcon({ live }: { live: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-4", live && "aide-wave-live")}
      fill="currentColor"
      aria-hidden
    >
      <rect className="aide-bar" x="1.5" y="6" width="1.8" height="4" rx="0.9" />
      <rect className="aide-bar" x="4.9" y="3.5" width="1.8" height="9" rx="0.9" />
      <rect className="aide-bar" x="8.3" y="1.5" width="1.8" height="13" rx="0.9" />
      <rect className="aide-bar" x="11.7" y="4.5" width="1.8" height="7" rx="0.9" />
    </svg>
  );
}

export function MicIcon({ slashed }: { slashed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <rect x="6" y="1.8" width="4" height="7" rx="2" fill="currentColor" stroke="none" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
      <path d="M8 12v2.2" />
      {slashed ? <path d="M2.5 2.5l11 11" strokeWidth="1.6" /> : null}
    </svg>
  );
}

/** A rounded stop square — ends the voice session. */
export function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
      <rect x="4" y="4" width="8" height="8" rx="1.6" />
    </svg>
  );
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Live call duration as m:ss, ticking each second; null when no live call. */
export function useCallElapsed(): string | null {
  const startedAt = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getLiveStartedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt == null ? null : formatElapsed(now - startedAt);
}
