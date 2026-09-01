// Aide sessions page: inspect voice sessions inside bb — the bb-native
// version of CodeAide's HTML session log. Lists sessions with cost, and shows
// a live-updating transcript: what you said, what Aide said, every tool call
// with arguments and result, and errors.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { voiceAgent } from "./voice-agent";
import { cn } from "@/lib/utils";

interface SessionRow {
  id: string;
  startedAt: number;
  lastEventAt: number;
  events: number;
  ended: boolean;
  costUsd: number;
}
interface EventRow {
  id: number;
  ts: number;
  kind: string;
  payload: string;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Open this plugin's settings page (Settings → Plugins → Handsfree). The SDK
 * only hands `openSettings()` to sidebar footer actions, so from a nav panel we
 * push the host route directly and nudge the router with a popstate event.
 */
function openHandsfreeSettings() {
  window.history.pushState({}, "", "/settings/plugins/handsfree");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The exact gear bb uses for its own Settings button (hugeicons Settings01). */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.3175 7.14139L20.8239 6.28479C20.4506 5.63696 20.264 5.31305 19.9464 5.18388C19.6288 5.05472 19.2696 5.15664 18.5513 5.36048L17.3311 5.70418C16.8725 5.80994 16.3913 5.74994 15.9726 5.53479L15.6357 5.34042C15.2766 5.11043 15.0004 4.77133 14.8475 4.37274L14.5136 3.37536C14.294 2.71534 14.1842 2.38533 13.9228 2.19657C13.6615 2.00781 13.3143 2.00781 12.6199 2.00781H11.5051C10.8108 2.00781 10.4636 2.00781 10.2022 2.19657C9.94085 2.38533 9.83106 2.71534 9.61149 3.37536L9.27753 4.37274C9.12465 4.77133 8.84845 5.11043 8.48937 5.34042L8.15249 5.53479C7.73374 5.74994 7.25259 5.80994 6.79398 5.70418L5.57375 5.36048C4.85541 5.15664 4.49625 5.05472 4.17867 5.18388C3.86109 5.31305 3.67445 5.63696 3.30115 6.28479L2.80757 7.14139C2.45766 7.74864 2.2827 8.05227 2.31666 8.37549C2.35061 8.69871 2.58483 8.95918 3.05326 9.48012L4.0843 10.6328C4.3363 10.9518 4.51521 11.5078 4.51521 12.0077C4.51521 12.5078 4.33636 13.0636 4.08433 13.3827L3.05326 14.5354C2.58483 15.0564 2.35062 15.3168 2.31666 15.6401C2.2827 15.9633 2.45766 16.2669 2.80757 16.8741L3.30114 17.7307C3.67443 18.3785 3.86109 18.7025 4.17867 18.8316C4.49625 18.9608 4.85542 18.8589 5.57377 18.655L6.79394 18.3113C7.25263 18.2055 7.73387 18.2656 8.15267 18.4808L8.4895 18.6752C8.84851 18.9052 9.12464 19.2442 9.2775 19.6428L9.61149 20.6403C9.83106 21.3003 9.94085 21.6303 10.2022 21.8191C10.4636 22.0078 10.8108 22.0078 11.5051 22.0078H12.6199C13.3143 22.0078 13.6615 22.0078 13.9228 21.8191C14.1842 21.6303 14.294 21.3003 14.5136 20.6403L14.8476 19.6428C15.0004 19.2442 15.2765 18.9052 15.6356 18.6752L15.9724 18.4808C16.3912 18.2656 16.8724 18.2055 17.3311 18.3113L18.5513 18.655C19.2696 18.8589 19.6288 18.9608 19.9464 18.8316C20.264 18.7025 20.4506 18.3785 20.8239 17.7307L21.3175 16.8741C21.6674 16.2669 21.8423 15.9633 21.8084 15.6401C21.7744 15.3168 21.5402 15.0564 21.0718 14.5354L20.0407 13.3827C19.7887 13.0636 19.6098 12.5078 19.6098 12.0077C19.6098 11.5078 19.7888 10.9518 20.0407 10.6328L21.0718 9.48012C21.5402 8.95918 21.7744 8.69871 21.8084 8.37549C21.8423 8.05227 21.6674 7.74864 21.3175 7.14139Z" />
      <path d="M15.5195 12C15.5195 13.933 13.9525 15.5 12.0195 15.5C10.0865 15.5 8.51953 13.933 8.51953 12C8.51953 10.067 10.0865 8.5 12.0195 8.5C13.9525 8.5 15.5195 10.067 15.5195 12Z" />
    </svg>
  );
}

/** Live session controls: state, mute/unmute, stop — right on the page. */
function SessionControls() {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  if (state === "idle") {
    return <span className="text-xs text-muted-foreground">No active session</span>;
  }
  const muted = state === "muted";
  return (
    <span className="flex items-center gap-2">
      <span className={cn("flex items-center gap-1.5 text-xs", muted ? "text-destructive" : "text-primary")}>
        <span className={cn("size-2 rounded-full", muted ? "bg-destructive/70" : "animate-pulse bg-primary")} />
        {state}
      </span>
      {state !== "connecting" ? (
        <button
          type="button"
          onClick={() => voiceAgent.toggleMute()}
          className={cn(
            "rounded-md border px-2 py-0.5 text-xs",
            muted
              ? "border-destructive text-destructive"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => voiceAgent.stop()}
        className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Stop
      </button>
    </span>
  );
}

function EventLine({ event }: { event: EventRow }) {
  const payload = parsePayload(event.payload);
  const time = <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{fmtTime(event.ts)}</span>;
  switch (event.kind) {
    case "user":
      return (
        <div className="flex gap-3 py-1.5">
          {time}
          <div className="text-sm">
            <span className="font-medium text-foreground">You</span>{" "}
            <span className="text-foreground/90">{String(payload.text ?? "")}</span>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex gap-3 py-1.5">
          {time}
          <div className="text-sm">
            <span className="font-medium text-primary">Aide</span>{" "}
            <span className="text-foreground/90">{String(payload.text ?? "")}</span>
          </div>
        </div>
      );
    case "tool.call":
      return (
        <div className="flex gap-3 py-1">
          {time}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            → {String(payload.name ?? "?")}({JSON.stringify(payload.args ?? {})})
          </code>
        </div>
      );
    case "tool.result": {
      const output = String(payload.output ?? "");
      return (
        <div className="flex gap-3 py-1">
          {time}
          <details className="min-w-0 flex-1">
            <summary className="cursor-pointer truncate font-mono text-xs text-muted-foreground">
              ← {String(payload.name ?? "?")}: {output.slice(0, 120)}
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs text-foreground/80">
              {output}
            </pre>
          </details>
        </div>
      );
    }
    case "notice":
      return (
        <div className="flex gap-3 py-1.5">
          {time}
          <span className="text-sm italic text-muted-foreground">🔔 {String(payload.text ?? "")}</span>
        </div>
      );
    case "error":
      return (
        <div className="flex gap-3 py-1.5">
          {time}
          <span className="text-sm text-destructive">{String(payload.message ?? "error")}</span>
        </div>
      );
    default:
      return (
        <div className="flex gap-3 py-1">
          {time}
          <span className="text-xs italic text-muted-foreground">{event.kind.replace("session.", "session ")}</span>
        </div>
      );
  }
}

/**
 * Close the page on Escape by going back in history (bb's router follows
 * popstate). Skips presses aimed at inputs/textareas/contenteditables and
 * ones something else already handled (e.g. closing a dialog), so Escape
 * still means "dismiss" inside nested UI.
 */
function useEscapeToClose() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }
      event.preventDefault();
      window.history.back();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function SessionsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  useEscapeToClose();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refetchSessions = useCallback(() => {
    rpc.call("listSessions", null).then(
      (result) => {
        setSessions(result.sessions);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  const refetchEvents = useCallback(
    (sessionId: string) => {
      rpc.call("getSessionEvents", { sessionId }).then(
        (result) => setEvents(result.events),
        () => undefined,
      );
    },
    [rpc],
  );

  useEffect(refetchSessions, [refetchSessions]);
  useEffect(() => {
    if (selected) refetchEvents(selected);
  }, [selected, refetchEvents]);

  // Live updates: the server publishes on every logged event.
  useRealtime("aide-log", (payload) => {
    refetchSessions();
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (selected && sessionId === selected) refetchEvents(selected);
  });

  const current = sessions?.find((session) => session.id === selected) ?? null;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {current ? (
          <>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                ← All sessions
              </button>
              <span className="text-sm text-foreground">
                {fmtDate(current.startedAt)} · {duration(current.startedAt, current.lastEventAt)} ·{" "}
                {current.ended ? "ended" : "live"} ·{" "}
                {current.costUsd > 0 ? `~$${current.costUsd.toFixed(4)}` : "no usage recorded"}
              </span>
            </div>
            <div className="divide-y divide-border/50 rounded-lg border border-border bg-card px-3 py-1">
              {events.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">No events.</p>
              ) : (
                events.map((event) => <EventLine key={event.id} event={event} />)
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">Aide Voice Session Transcripts</p>
              <span className="flex items-center gap-4">
                <SessionControls />
                <button
                  type="button"
                  onClick={openHandsfreeSettings}
                  title="Open Handsfree settings"
                  aria-label="Open Handsfree settings"
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <GearIcon />
                  Settings
                </button>
              </span>
            </div>
            <div className="divide-y divide-border/50 rounded-lg border border-border bg-card">
              {sessions === null ? (
                <p className="p-3 text-sm text-muted-foreground">Loading…</p>
              ) : sessions.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No sessions yet. Click the waveform button in any composer and start talking.
                </p>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelected(session.id)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        session.ended ? "bg-border" : "animate-pulse bg-primary",
                      )}
                    />
                    <span className="flex-1 text-sm text-foreground">{fmtDate(session.startedAt)}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {duration(session.startedAt, session.lastEventAt)} · {session.events} events ·{" "}
                      {session.costUsd > 0 ? `~$${session.costUsd.toFixed(4)}` : "no usage"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
