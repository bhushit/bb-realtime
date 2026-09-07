// Incoming-call UI for Tier-0 autonomous invocation: renders the ringing
// `voice-invite` with Accept / Snooze / Dismiss. Accept starts a normal voice
// session (the click is the user gesture mic + playback need); snooze re-rings
// locally after N minutes; dismiss or expiry just goes quiet.
import { useEffect, useSyncExternalStore } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { voiceAgent } from "./voice-agent";
import { DEFAULT_SNOOZE_MINUTES, INVITE_CHANNEL, inviteStore } from "./voice-invite.ts";
import { cn } from "@/lib/utils";

/** Double-beep ringtone while an invite is ringing. Best-effort: before the
 * user has ever interacted with the tab, autoplay policy keeps the context
 * suspended and only the visual card + vibration ring. */
function useRingtone(ringing: boolean) {
  useEffect(() => {
    if (!ringing || typeof window === "undefined") return;
    let ctx: AudioContext | null = null;
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    try {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      void ctx.resume().catch(() => undefined);
      const beep = (freq: number, at: number, dur = 0.18) => {
        if (!ctx || stopped) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.05);
      };
      const pattern = () => {
        if (!ctx || stopped) return;
        const t = ctx.currentTime + 0.05;
        beep(880, t);
        beep(880, t + 0.28);
      };
      pattern();
      interval = setInterval(pattern, 2000);
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {
        /* vibration is a nicety */
      }
    } catch {
      /* audio unavailable — the visual card still rings */
    }
    return () => {
      stopped = true;
      if (interval) clearInterval(interval);
      ctx?.close().catch(() => undefined);
    };
  }, [ringing]);
}

function InviteBody({ onAccept }: { onAccept: () => void }) {
  const invite = useSyncExternalStore(inviteStore.subscribe, inviteStore.getSnapshot);
  if (!invite) return null;
  return (
    <div className="w-full">
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Incoming call
        </span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-foreground">{invite.title}</p>
      {invite.briefing ? (
        <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{invite.briefing}</p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onAccept}
          className="flex-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => inviteStore.snooze(DEFAULT_SNOOZE_MINUTES)}
          title={`Ring again in ${DEFAULT_SNOOZE_MINUTES} minutes`}
          className="rounded-full border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Snooze {DEFAULT_SNOOZE_MINUTES}m
        </button>
        <button
          type="button"
          onClick={() => inviteStore.dismiss()}
          aria-label="Dismiss invite"
          title="Dismiss"
          className="rounded-full border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
/**
 * App-wide incoming-call overlay (registered as `experimental_appOverlay`, so
 * it mounts on every page — thread views, the Handsfree page, settings, other
 * plugins' pages). Top-right toast placement keeps it clear of the composer.
 * While already in a call the invite is moot, so it steps aside (and drops
 * the invite — whoever is talking already has the floor).
 */
export function GlobalInviteOverlay() {
  useRealtime(INVITE_CHANNEL, (payload) => inviteStore.ingestInvite(payload));
  const invite = useSyncExternalStore(inviteStore.subscribe, inviteStore.getSnapshot);
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const inCall = state !== "idle";
  useRingtone(!!invite && !inCall);
  useEffect(() => {
    if (invite && inCall) inviteStore.dismiss();
  }, [invite, inCall]);
  if (!invite || inCall) return null;
  const accept = () => {
    inviteStore.dismiss();
    voiceAgent.acceptInvite(invite.title, invite.briefing);
  };
  return (
    <div
      role="alertdialog"
      aria-label={`Incoming call: ${invite.title}`}
      className={cn(
        "fixed right-4 top-4 z-50 w-80 max-w-[calc(100vw-2rem)]",
        "rounded-xl border border-primary/40 bg-card p-3.5 shadow-xl",
      )}
    >
      <InviteBody onAccept={accept} />
    </div>
  );
}
