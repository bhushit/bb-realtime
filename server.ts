// bb-plugin-aide — BB Aide: a realtime voice operator for bb.
//
// The frontend (app.tsx) captures mic audio over WebRTC directly in the bb
// app; this backend holds the OpenAI API key, performs the SDP exchange with
// the OpenAI Realtime API, and executes the voice agent's tools against the
// bb SDK (threads, projects, diffs, panes).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  /** Exchange a WebRTC SDP offer with OpenAI Realtime. Returns the answer. */
  createCall: {
    input: z
      .object({
        sdp: z.string().min(1),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: z.object({ sdp: z.string() }).strict(),
  },
  /** Run one realtime tool call against the bb SDK. Always returns text. */
  runTool: {
    input: z
      .object({
        name: z.string(),
        args: z.record(z.string(), z.unknown()),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: z.object({ output: z.string() }).strict(),
  },
});

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/calls";

function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function toolSchemas() {
  return [
    { type: "function", name: "get_context", description: "Get the user's current bb context: the thread and project currently in view, including the thread's status and latest assistant output." },
    { type: "function", name: "list_projects", description: "List bb projects with their ids and names." },
    { type: "function", name: "list_live_threads", description: "List the threads that are live right now (running, starting, provisioning, or waiting), like the Live threads section in the bb sidebar." },
    { type: "function", name: "list_threads", description: "List recent bb threads (id, title, status). Optionally filter by project id.", parameters: { type: "object", properties: { project_id: { type: "string" }, limit: { type: "number", description: "Max threads to return (default 15)." } } } },
    { type: "function", name: "search_threads", description: "Full-text search bb threads by title/content. Returns matching thread ids and titles.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { type: "function", name: "read_thread", description: "Read a thread's details and its latest assistant output.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    { type: "function", name: "focus_thread", description: "Open/focus a thread in the user's bb app window.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    { type: "function", name: "set_pane", description: "Change a thread pane's presentation in the bb app: spotlight, clear-spotlight, maximize, restore, or toggle.", parameters: { type: "object", properties: { thread_id: { type: "string" }, action: { type: "string", enum: ["spotlight", "clear-spotlight", "maximize", "restore", "toggle"] } }, required: ["thread_id", "action"] } },
    { type: "function", name: "send_to_thread", description: "Send a message to a thread's agent. Starts a turn if idle, queues/steers if running.", parameters: { type: "object", properties: { thread_id: { type: "string" }, message: { type: "string" } }, required: ["thread_id", "message"] } },
    { type: "function", name: "start_thread", description: "Start a new agent thread in a project with an initial prompt.", parameters: { type: "object", properties: { project_id: { type: "string", description: "Project id; defaults to the user's current project." }, prompt: { type: "string" }, title: { type: "string" } }, required: ["prompt"] } },
    { type: "function", name: "stop_thread", description: "Stop a running thread.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    { type: "function", name: "archive_thread", description: "Archive a thread (and its children).", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    { type: "function", name: "rename_thread", description: "Rename a thread.", parameters: { type: "object", properties: { thread_id: { type: "string" }, title: { type: "string" } }, required: ["thread_id", "title"] } },
    { type: "function", name: "show_diff", description: "Summarize a thread's workspace diff (changed files, additions/deletions) and focus the thread so the user can see it.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    // Handled locally in the bb app frontend, never reaches runTool:
    { type: "function", name: "set_composer_text", description: "Replace the text in the user's message composer (the box they type prompts into).", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { type: "function", name: "append_composer_text", description: "Append text to the user's message composer.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ];
}

function instructions(context: { threadId: string | null; projectId: string | null }): string {
  return `You are BB Aide, a concise voice operator for bb — the user's agentic IDE where coding agents run in threads inside projects.

The user talks to you to drive bb hands-free. You can list/search/read threads, focus them on screen, spotlight or maximize panes, send messages to agent threads, start new threads, stop or archive threads, summarize diffs, and edit the user's prompt composer.

Current context: threadId=${context.threadId ?? "none"}, projectId=${context.projectId ?? "none"}. Call get_context for fresh context — the user navigates while talking.

Rules:
- Thread ids look like thr_x… and project ids like proj_x…. When the user names a thread by topic or title, find it with list_threads or search_threads first.
- After acting, confirm briefly. Keep responses short — one or two sentences unless the user asks for detail.
- When reading agent output aloud, summarize; never read code or ids verbatim.
- Prefer focus_thread so the user sees what you are talking about.`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    openaiApiKey: { type: "string", label: "OpenAI API key", secret: true },
    model: { type: "string", label: "Realtime model", default: "gpt-realtime-2" },
    voice: { type: "string", label: "Voice", default: "marin" },
  });

  async function apiKey(): Promise<string> {
    const { openaiApiKey } = await settings.get();
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("No OpenAI API key. Set it with: bb plugin config aide set openaiApiKey <key>");
    }
    return key;
  }

  {
    const { openaiApiKey } = await settings.get();
    if (!openaiApiKey && !process.env.OPENAI_API_KEY) {
      bb.status.needsConfiguration("Set openaiApiKey with `bb plugin config aide set openaiApiKey <key>`, then reload.");
    }
  }

  const LIVE_STATUSES = new Set([
    "active",
    "starting",
    "stopping",
    "provisioning",
    "waiting-for-host",
    "host-reconnecting",
  ]);

  /** Threads that are live right now, newest activity first, with project names. */
  async function liveThreads() {
    const [threads, projects] = await Promise.all([
      bb.sdk.threads.list({ limit: 200 }),
      bb.sdk.projects.list({ includePersonal: true }),
    ]);
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    return threads
      .filter((t) => !t.archivedAt && LIVE_STATUSES.has(t.runtime.displayStatus))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({
        id: t.id,
        title: t.title ?? t.titleFallback ?? "(untitled)",
        status: t.runtime.displayStatus,
        project: projectNames.get(t.projectId) ?? t.projectId,
        projectId: t.projectId,
        providerId: t.providerId,
        updatedAt: t.updatedAt,
      }));
  }

  function relativeTime(timestamp: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  async function resolveEnvironmentId(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    return (thread as { environmentId?: string | null }).environmentId ?? null;
  }

  function describeThread(thread: unknown): Record<string, unknown> {
    const t = thread as Record<string, unknown>;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      projectId: t.projectId,
      providerId: t.providerId ?? t.provider,
    };
  }

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    context: { threadId: string | null; projectId: string | null },
  ): Promise<string> {
    const str = (key: string): string => {
      const value = args[key];
      if (typeof value !== "string" || !value) throw new Error(`Missing argument: ${key}`);
      return value;
    };
    switch (name) {
      case "get_context": {
        const result: Record<string, unknown> = { threadId: context.threadId, projectId: context.projectId };
        if (context.threadId) {
          const thread = await bb.sdk.threads.get({ threadId: context.threadId });
          result.thread = describeThread(thread);
          const { output } = await bb.sdk.threads.output({ threadId: context.threadId });
          if (output) result.lastAssistantOutput = truncate(output, 2000);
        }
        if (context.projectId) {
          const projects = await bb.sdk.projects.list({ includePersonal: true });
          const project = projects.find((p) => p.id === context.projectId);
          if (project) result.project = { id: project.id, name: project.name };
        }
        return JSON.stringify(result);
      }
      case "list_projects": {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        return JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name })));
      }
      case "list_live_threads": {
        const live = await liveThreads();
        return live.length === 0 ? "No live threads right now." : JSON.stringify(live);
      }
      case "list_threads": {
        const projectId = typeof args.project_id === "string" ? args.project_id : undefined;
        const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 15;
        const threads = await bb.sdk.threads.list({ projectId, limit });
        return JSON.stringify(threads.map(describeThread));
      }
      case "search_threads": {
        const result = await bb.sdk.threads.search({ query: str("query") });
        return truncate(JSON.stringify(result), 6000);
      }
      case "read_thread": {
        const threadId = str("thread_id");
        const thread = await bb.sdk.threads.get({ threadId });
        const { output } = await bb.sdk.threads.output({ threadId });
        return JSON.stringify({ ...describeThread(thread), lastAssistantOutput: output ? truncate(output) : null });
      }
      case "focus_thread": {
        const { delivered } = await bb.sdk.threads.open({ threadId: str("thread_id"), file: null });
        return delivered > 0 ? "Focused." : "No connected bb window received the action.";
      }
      case "set_pane": {
        const action = str("action") as "spotlight" | "clear-spotlight" | "maximize" | "restore" | "toggle";
        const { delivered } = await bb.sdk.threads.paneAction({ threadId: str("thread_id"), action });
        return delivered > 0 ? `Pane ${action} applied.` : "No connected bb window received the action.";
      }
      case "send_to_thread": {
        await bb.sdk.threads.send({
          threadId: str("thread_id"),
          mode: "auto",
          input: [{ type: "text", text: str("message"), mentions: [] }],
        });
        return "Message sent.";
      }
      case "start_thread": {
        const projectId = typeof args.project_id === "string" && args.project_id ? args.project_id : context.projectId;
        if (!projectId) return "Error: no project_id given and no current project. Ask the user or call list_projects.";
        const thread = await bb.sdk.threads.spawn({
          projectId,
          environment: { type: "project-default" },
          prompt: str("prompt"),
          ...(typeof args.title === "string" && args.title ? { title: args.title } : {}),
        });
        await bb.sdk.threads.open({ threadId: thread.id, file: null }).catch(() => undefined);
        return JSON.stringify({ started: describeThread(thread) });
      }
      case "stop_thread": {
        await bb.sdk.threads.stop({ threadId: str("thread_id") });
        return "Thread stopped.";
      }
      case "archive_thread": {
        await bb.sdk.threads.archive({ threadId: str("thread_id") });
        return "Thread archived.";
      }
      case "rename_thread": {
        await bb.sdk.threads.update({ threadId: str("thread_id"), title: str("title") });
        return "Thread renamed.";
      }
      case "show_diff": {
        const threadId = str("thread_id");
        const environmentId = await resolveEnvironmentId(threadId);
        if (!environmentId) return "This thread has no environment, so there is no diff.";
        const environment = await bb.sdk.environments.get({ environmentId });
        const mergeBaseBranch = (environment as { mergeBaseBranch?: string | null }).mergeBaseBranch;
        const diff = await bb.sdk.environments.diffFiles(
          mergeBaseBranch
            ? { environmentId, target: "all", mergeBaseBranch }
            : { environmentId, target: "uncommitted" },
        );
        await bb.sdk.threads.open({ threadId, file: null }).catch(() => undefined);
        if (diff.outcome !== "available") return `Diff not available (${diff.outcome}).`;
        const files = diff.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
        return JSON.stringify({ shortstat: diff.shortstat, files: files.slice(0, 50) });
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  bb.cli.register({
    name: "aide",
    summary: "BB Aide: inspect live (running) bb threads",
    commands: [
      { name: "live", summary: "List threads that are live right now (running/starting/waiting). Add --json for machine output.", usage: "bb aide live [--json]" },
      { name: "read", summary: "Read a thread's status and latest assistant output.", usage: "bb aide read <thread-id>" },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      try {
        if (command === "live" || command === undefined) {
          const live = await liveThreads();
          if (rest.includes("--json") || argv.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify(live, null, 2) };
          }
          if (live.length === 0) return { exitCode: 0, stdout: "No live threads right now." };
          const lines = live.map(
            (t) => `${t.id}  [${t.status}]  ${t.title}  (${t.project} \u00b7 ${t.providerId} \u00b7 ${relativeTime(t.updatedAt)})`,
          );
          return { exitCode: 0, stdout: `${live.length} live thread(s):\n${lines.join("\n")}` };
        }
        if (command === "read") {
          const threadId = rest.find((arg) => !arg.startsWith("-"));
          if (!threadId) return { exitCode: 1, stderr: "Usage: bb aide read <thread-id>" };
          const thread = await bb.sdk.threads.get({ threadId });
          const { output } = await bb.sdk.threads.output({ threadId });
          const t = thread as { title?: string | null; status?: string };
          const header = `${threadId}  [${t.status ?? "?"}]  ${t.title ?? "(untitled)"}`;
          return { exitCode: 0, stdout: `${header}\n\n${output ? truncate(output, 20000) : "(no assistant output yet)"}` };
        }
        return { exitCode: 1, stderr: `Unknown command: ${command}. Try: bb aide live | bb aide read <thread-id>` };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  bb.rpc.register(rpcContract, {
    async createCall({ sdp, threadId, projectId }) {
      const key = await apiKey();
      const { model, voice } = await settings.get();
      const session = {
        type: "realtime",
        model,
        instructions: instructions({ threadId, projectId }),
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: { model: "gpt-realtime-whisper" },
          },
          output: { voice },
        },
        tools: toolSchemas(),
      };
      const form = new FormData();
      form.set("sdp", sdp);
      form.set("session", JSON.stringify(session));
      const response = await fetch(REALTIME_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const text = await response.text();
      if (!response.ok) {
        bb.log.error(`OpenAI realtime call failed: ${response.status} ${text.slice(0, 500)}`);
        throw new Error(`OpenAI realtime call failed: ${response.status} ${response.statusText}`);
      }
      return { sdp: text };
    },
    async runTool({ name, args, threadId, projectId }) {
      bb.log.info(`voice tool: ${name} ${JSON.stringify(args).slice(0, 300)}`);
      try {
        const output = await runTool(name, args, { threadId, projectId });
        return { output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bb.log.warn(`voice tool ${name} failed: ${message}`);
        return { output: `Tool error: ${message}` };
      }
    },
  });
}
