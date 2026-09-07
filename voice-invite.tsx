// Incoming-call UI for Tier-0 autonomous invocation: renders the ringing
// `voice-invite` with Accept / Snooze / Dismiss. Accept starts a normal voice
// session (the click is the user gesture mic + playback need); snooze re-rings
// locally after N minutes; dismiss or expiry just goes quiet.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  experimental_useSidebarThreadActions,
  useBbContext,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { clientDescriptor } from "./client-identity";
import { voiceAgent } from "./voice-agent";
import { LiveCallControls } from "./voice-chrome";
import {
  DEFAULT_SNOOZE_MINUTES,
  INVITE_CHANNEL,
  INVITE_RESOLVED_CHANNEL,
  inviteStore,
} from "./voice-invite.ts";
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
function InviteBody({ onAccept, onDismiss }: { onAccept: () => void; onDismiss: () => void }) {
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
          onClick={onDismiss}
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
 *
 * Answering/dismissing here resolves through the server, so every other
 * surface stops ringing too; snooze stays local to this surface by design.
 * Mobile stays silent for now: the native webview cannot reliably start a
 * call (see HF-2), and the phone path waits on Expo push (HF-12).
 */
export function GlobalInviteOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = useBbContext();
  const sidebarActions = experimental_useSidebarThreadActions();
  useRealtime(INVITE_CHANNEL, (payload) => inviteStore.ingestInvite(payload));
  useRealtime(INVITE_RESOLVED_CHANNEL, (payload) => {
    inviteStore.resolveInvite((payload as { inviteId?: unknown } | null)?.inviteId);
  });

  // Fallback voice binding so Accept can start a call from pages with no
  // composer of their own. Thread views keep their richer composer binding —
  // fallbacks never win over those (see registerBindings).
  useEffect(() => {
    return voiceAgent.bindFallback({
      rpc,
      context: { threadId: threadId ?? null, projectId: projectId ?? null, onNewThreadScreen: false },
      openNewThread: (targetProjectId) =>
        sidebarActions.openNewThread({
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          focusPrompt: true,
        }),
    });
  }, [rpc, threadId, projectId, sidebarActions]);

  const invite = useSyncExternalStore(inviteStore.subscribe, inviteStore.getSnapshot);
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const inCall = state !== "idle";
  const mobile = clientDescriptor.mobile;
  // The surface that accepted keeps a live-call card (mute/stop + status) so
  // Accepting from a page with no voice UI of its own never strands the call
  // without controls. Cleared when the call ends.
  const [accepted, setAccepted] = useState<{ inviteId: string; title: string } | null>(null);
  useRingtone(!!invite && !inCall && !mobile);
  useEffect(() => {
    if (invite && inCall) inviteStore.dismiss();
  }, [invite, inCall]);
  useEffect(() => {
    if (state === "idle") setAccepted(null);
  }, [state]);
  if (mobile) return null;
  if (!invite && !(accepted && inCall)) return null;
  const resolve = (action: "answered" | "dismissed") => {
    const id = invite?.inviteId ?? accepted?.inviteId;
    if (!id) return;
    void rpc
      .call("resolveInvite", { inviteId: id, action })
      .catch(() => undefined);
  };
  const accept = () => {
    if (!invite) return;
    setAccepted({ inviteId: invite.inviteId, title: invite.title });
    inviteStore.dismiss();
    resolve("answered");
    voiceAgent.acceptInvite(invite.title, invite.briefing);
  };
  const dismiss = () => {
    inviteStore.dismiss();
    resolve("dismissed");
  };
  return (
    <div
      role="alertdialog"
      aria-label={invite ? `Incoming call: ${invite.title}` : `On call: ${accepted?.title ?? "Aide"}`}
      className={cn(
        "fixed right-4 top-4 z-50 w-80 max-w-[calc(100vw-2rem)]",
        "rounded-xl border border-primary/40 bg-card p-3.5 shadow-xl",
      )}
    >
      {invite && !inCall ? (
        <InviteBody onAccept={accept} onDismiss={dismiss} />
      ) : (
        <div className="w-full">
          <div className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
              On call{accepted?.title ? ` — ${accepted.title}` : ""}
            </span>
          </div>
          <div className="mt-2.5 flex justify-center">
            <LiveCallControls />
          </div>
        </div>
      )}
    </div>
  );
}
