// bb-plugin-handsfree — frontend: a voice-agent toggle in the composer.
//
// A circular waveform button rendered beside the native mic/submit controls.
// Clicking it opens a WebRTC session with the OpenAI Realtime API (mic capture
// and audio playback happen right here in the bb app); the backend performs
// the SDP exchange (it holds the API key) and executes bb tools via bb.sdk.
// The session itself lives in voice-agent.ts and outlives any component.
import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  useBbContext,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { voiceAgent } from "./voice-agent";
import { SessionsPanel } from "./sessions-panel";
import { cn } from "@/lib/utils";
import "./app.css";


function WaveformIcon({ live }: { live: boolean }) {
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

function MicIcon({ slashed }: { slashed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <rect x="6" y="1.8" width="4" height="7" rx="2" fill="currentColor" stroke="none" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
      <path d="M8 12v2.2" />
      {slashed ? <path d="M2.5 2.5l11 11" strokeWidth="1.6" /> : null}
    </svg>
  );
}

function AideVoiceButton() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const { threadId, projectId } = useBbContext();
  const sidebarActions = experimental_useSidebarThreadActions();
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);

  // Global exclusivity: when any window starts a call, all others stop theirs.
  useRealtime("voice-call", (payload) => {
    const nonce = (payload as { nonce?: unknown } | null)?.nonce;
    if (typeof nonce === "string") voiceAgent.onCallStarted(nonce);
  });

  // CLI mute control: bb handsfree mute|unmute broadcasts on this channel.
  useRealtime("voice-mute", (payload) => {
    const muted = (payload as { muted?: unknown } | null)?.muted;
    if (typeof muted === "boolean") voiceAgent.setMuted(muted);
  });

  // Thread-event notifications (digested; disabled via `notifications` setting).
  useRealtime("aide-thread-event", (payload) => {
    const event = payload as { kind?: unknown; threadId?: unknown; title?: unknown } | null;
    if (typeof event?.kind === "string" && typeof event.threadId === "string" && typeof event.title === "string") {
      voiceAgent.enqueueThreadEvent({ kind: event.kind, threadId: event.threadId, title: event.title });
    }
  });

  // Keep the singleton pointed at the freshest surface: after navigation the
  // new composer's button mounts and rebinds, so "this thread" and composer
  // edits follow the user while the call keeps running.
  useEffect(() => {
    voiceAgent.bind({
      rpc,
      context: { threadId, projectId },
      composer: {
        setText: (text) => composer.setText(text),
        updateText: (updater) => composer.updateText(updater),
      },
      openNewThread: (targetProjectId) =>
        sidebarActions.openNewThread({
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          focusPrompt: true,
        }),
    });
  }, [rpc, composer, threadId, projectId, sidebarActions]);

  const live = state === "live";
  const muted = state === "muted";
  return (
    <>
      {live || muted ? (
        <button
          type="button"
          aria-label={muted ? "Unmute Aide microphone" : "Mute Aide microphone"}
          title={muted ? "Unmute" : "Mute"}
          onClick={() => voiceAgent.toggleMute()}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors",
            muted
              ? "border-destructive bg-destructive/15 text-destructive"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <MicIcon slashed={muted} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={live || muted ? "Stop Aide voice agent" : "Start Aide voice agent"}
        title={live || muted ? "Stop Aide" : "Talk to Aide"}
        onClick={() => voiceAgent.toggle()}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors",
          state === "idle" &&
            "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          state === "connecting" && "animate-pulse border-primary/50 text-primary",
          live && "border-primary bg-primary/15 text-primary",
          muted && "border-primary/40 bg-primary/5 text-primary/60",
        )}
      >
        <WaveformIcon live={live} />
      </button>
    </>
  );
}

/** Trailing accessory on the Aide sidebar row: shows when a call is on. */
function SidebarLiveIndicator() {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  if (state === "idle") return null;
  if (state === "muted") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <span className="size-2 rounded-full bg-destructive/70" />
        muted
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-primary">
      <span
        className={cn(
          "size-2 rounded-full bg-primary",
          state === "live" ? "animate-pulse" : "opacity-50",
        )}
      />
      {state === "live" ? "live" : "\u2026"}
    </span>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "aide-voice",
    actions: [{ id: "voice-agent", component: AideVoiceButton }],
  });
  app.slots.navPanel({
    id: "sessions",
    title: "Handsfree",
    icon: "AudioLines",
    path: "sessions",
    component: SessionsPanel,
    experimental_sidebarAccessory: SidebarLiveIndicator,
  });
  // The session deliberately outlives any component, so tie it to the plugin
  // frontend generation instead: on reload/disable the old bundle's singleton
  // would otherwise keep a zombie WebRTC call no button controls.
  app.contentScripts.register({
    id: "aide-voice-lifecycle",
    mount({ signal }) {
      signal.addEventListener("abort", () => voiceAgent.stop());
      return () => voiceAgent.stop();
    },
  });
});
