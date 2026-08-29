// Aide sessions page: inspect voice sessions inside bb — the bb-native
// version of CodeAide's HTML session log. Lists sessions with cost, and shows
// a live-updating transcript: what you said, what Aide said, every tool call
// with arguments and result, and errors.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { DEFAULT_MODEL, MODEL_OPTIONS, type RealtimeModel } from "./models";
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

function ModelPicker() {
  const rpc = useRpc<typeof rpcContract>();
  const { values, isLoading } = useSettings();
  const [model, setModel] = useState<RealtimeModel | null>(null);
  const configured = typeof values?.model === "string" ? values.model : DEFAULT_MODEL;
  const current = model ?? (MODEL_OPTIONS.includes(configured as RealtimeModel) ? (configured as RealtimeModel) : DEFAULT_MODEL);

  async function change(next: RealtimeModel) {
    setModel(next);
    try {
      await rpc.call("setModel", { model: next });
      toast.success(`Voice model: ${next} (applies to the next session)`);
    } catch (cause) {
      setModel(null);
      toast.error(`Could not switch model: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      Model
      <select
        value={current}
        disabled={isLoading}
        onChange={(event) => void change(event.target.value as RealtimeModel)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
      >
        {MODEL_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

interface PromptVersion {
  id: number;
  ts: number;
  source: string;
  note: string | null;
  content: string;
}

function PromptEditor() {
  const rpc = useRpc<typeof rpcContract>();
  const [active, setActive] = useState("");
  const [defaultContent, setDefaultContent] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [versions, setVersions] = useState<PromptVersion[]>([]);

  const refetch = useCallback(() => {
    rpc.call("getPrompt", null).then((result) => {
      setActive(result.content);
      setDefaultContent(result.defaultContent);
      setVersions(result.versions);
    }, () => undefined);
  }, [rpc]);

  useEffect(refetch, [refetch]);
  useRealtime("prompt-changed", refetch);

  const text = draft ?? active;
  const dirty = draft !== null && draft !== active;

  async function save(content: string, note: string | null) {
    try {
      await rpc.call("setPrompt", { content, source: "user", note });
      setDraft(null);
      toast.success("Prompt saved — applies to the next session");
    } catch (cause) {
      toast.error(`Could not save prompt: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return (
    <details className="rounded-lg border border-border bg-card">
      <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-foreground">
        Prompt
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {versions.length === 0 ? "built-in default" : `v${versions[0]?.id} · ${versions.length} revision(s)`}
        </span>
      </summary>
      <div className="space-y-3 border-t border-border/50 p-3">
        <textarea
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!dirty || text.trim().length === 0}
            onClick={() => void save(text, "edited in Realtime page")}
            className="rounded-md border border-border bg-primary/10 px-3 py-1 text-sm text-primary disabled:opacity-40"
          >
            Save
          </button>
          {dirty ? (
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
            >
              Discard
            </button>
          ) : null}
          {active !== defaultContent ? (
            <button
              type="button"
              onClick={() => void save(defaultContent, "reset to built-in default")}
              className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Reset to default
            </button>
          ) : null}
        </div>
        {versions.length > 0 ? (
          <div className="divide-y divide-border/50 rounded-md border border-border/70">
            {versions.map((version, index) => (
              <div key={version.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <span className="tabular-nums text-muted-foreground">{fmtDate(version.ts)}</span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    version.source === "agent" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  {version.source}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {version.note ?? version.content.slice(0, 80)}
                </span>
                {index === 0 ? (
                  <span className="text-muted-foreground">active</span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setDraft(version.content)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      view
                    </button>
                    <button
                      type="button"
                      onClick={() => void save(version.content, `restored v${version.id}`)}
                      className="text-primary hover:underline"
                    >
                      restore
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
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

export function SessionsPanel() {
  const rpc = useRpc<typeof rpcContract>();
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
                {current.ended ? "ended" : "live"} · ~${current.costUsd.toFixed(4)}
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
              <ModelPicker />
            </div>
            <PromptEditor />
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
                      {duration(session.startedAt, session.lastEventAt)} · {session.events} events · ~$
                      {session.costUsd.toFixed(4)}
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
