// The app-global voice session singleton. Lives in its own module so both
// the composer button (app.tsx) and the Realtime page (sessions-panel.tsx)
// can control one shared session without a circular import.
import { toast } from "sonner";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  audioCaptureConstraint,
  readAudioDevicePreferences,
  shouldRetryWithDefaultDevice,
  writeAudioDevicePreferences,
  type AudioDevicePreferences,
} from "./audio-devices.ts";

export type VoiceState = "idle" | "connecting" | "live" | "muted";

interface RpcClient {
  call: ReturnType<typeof useRpc<typeof rpcContract>>["call"];
}

interface ComposerBinding {
  setText: (text: string) => void;
  updateText: (updater: (current: string) => string) => void;
}

export interface Bindings {
  rpc: RpcClient;
  context: { threadId: string | null; projectId: string | null };
  composer: ComposerBinding;
  openNewThread: (projectId: string | null) => void;
}

interface SessionHandle {
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  dc: RTCDataChannel | null;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Wait for ICE gathering to finish (bounded) so we send a complete offer. */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * App-global voice session. Mounted buttons keep `bindings` fresh (latest
 * composer + route context win), so tool calls always act on what the user
 * is currently looking at, and navigation never interrupts the call.
 */
export class VoiceAgent {
  private state: VoiceState = "idle";
  private session: SessionHandle | null = null;
  private listeners = new Set<() => void>();
  private bindings: Bindings | null = null;
  private nonce: string | null = null;
  private storage = browserStorage();
  private audioPreferences: AudioDevicePreferences =
    this.storage
      ? readAudioDevicePreferences(this.storage)
      : { inputDeviceId: "", outputDeviceId: "" };
  /** Serializes tool executions so outputs are submitted in call order. */
  private toolChain: Promise<void> = Promise.resolve();
  /** True while the model is generating a response (response.created→done). */
  private responseActive = false;
  /** A response.create is owed once the active response finishes. */
  private responsePending = false;
  // ---- thread-event notifications (see server: `notifications` setting) ----
  /** Pending thread events, deduped per thread; latest state wins. */
  private pendingNotices = new Map<string, { kind: string; title: string }>();
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** True between VAD speech_started and speech_stopped. */
  private userSpeaking = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): VoiceState => this.state;

  readonly getAudioPreferences = (): AudioDevicePreferences => this.audioPreferences;

  bind(bindings: Bindings) {
    this.bindings = bindings;
  }

  private setState(next: VoiceState) {
    this.state = next;
    this.emitChange();
  }

  private emitChange() {
    for (const listener of this.listeners) listener();
  }

  setAudioPreferences(next: AudioDevicePreferences) {
    this.audioPreferences = { ...next };
    if (this.storage) writeAudioDevicePreferences(this.storage, this.audioPreferences);
    this.emitChange();
  }

  refreshAudioPreferences() {
    if (!this.storage) return;
    const next = readAudioDevicePreferences(this.storage);
    if (
      next.inputDeviceId === this.audioPreferences.inputDeviceId &&
      next.outputDeviceId === this.audioPreferences.outputDeviceId
    ) return;
    this.audioPreferences = next;
    this.emitChange();
  }

  toggle() {
    if (this.state === "idle") void this.start();
    else this.stop();
  }


  /** Fire-and-forget transcript logging; must never affect the call. */
  private log(kind: string, payload: Record<string, unknown> = {}) {
    const sessionId = this.nonce;
    const bindings = this.bindings;
    if (!sessionId || !bindings) return;
    void bindings.rpc.call("logEvent", { sessionId, kind, payload }).catch(() => undefined);
  }

  /** Mute = mic track sends silence; the call and playback stay up. */
  setMuted(muted: boolean) {
    const session = this.session;
    if (!session || (this.state !== "live" && this.state !== "muted")) return;
    for (const track of session.stream.getAudioTracks()) track.enabled = !muted;
    this.log(muted ? "muted" : "unmuted");
    this.userSpeaking = false; // a muted mic can't be mid-utterance
    this.setState(muted ? "muted" : "live");
  }

  toggleMute() {
    this.setMuted(this.state !== "muted");
  }

  /** Queue a thread event; announced as one digest when the session is quiet. */
  enqueueThreadEvent(event: { kind: string; threadId: string; title: string }) {
    if (!this.session) return; // only the window that owns the call announces
    this.pendingNotices.set(event.threadId, { kind: event.kind, title: event.title });
    this.scheduleNoticeDrain();
  }

  /** Debounce so simultaneous finishers coalesce into one announcement. */
  private scheduleNoticeDrain(delayMs = 2000) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.drainNotices();
    }, delayMs);
  }

  private drainNotices() {
    const dc = this.session?.dc;
    if (!dc || dc.readyState !== "open" || this.pendingNotices.size === 0) return;
    // Never interrupt: wait for the user and the model to both go quiet.
    if (this.userSpeaking || this.responseActive) return; // retried on quiet
    const entries = [...this.pendingNotices.values()];
    this.pendingNotices.clear();
    const failed = entries.filter((entry) => entry.kind === "failed");
    const finished = entries.filter((entry) => entry.kind !== "failed");
    const parts = [
      ...(failed.length > 0 ? [`failed: ${failed.map((entry) => entry.title).join(", ")}`] : []),
      ...(finished.length > 0 ? [`finished: ${finished.map((entry) => entry.title).join(", ")}`] : []),
    ];
    const text =
      entries.length > 5
        ? `${entries.length} threads changed state (${failed.length} failed). Offer the user the list.`
        : `Thread update — ${parts.join("; ")}.`;
    this.log("notice", { text });
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `[bb update] ${text} Tell the user in ONE short sentence. They can ask for details.`,
            },
          ],
        },
      }),
    );
    this.requestResponse(dc);
  }

  /** Another window (or this one) started a call: only the newest survives. */
  onCallStarted(nonce: string) {
    if (nonce && nonce !== this.nonce && this.state !== "idle") {
      toast.info("Aide: voice session taken over elsewhere");
      this.stop();
    }
  }

  /**
   * Ask the model to continue — at most one response.create in flight.
   * The realtime API rejects response.create while a response is being
   * generated (e.g. two tool calls in one response would send two), so an
   * active response defers a single coalesced create until response.done.
   */
  private requestResponse(dc: RTCDataChannel) {
    if (dc.readyState !== "open") return;
    if (this.responseActive) {
      this.responsePending = true;
      return;
    }
    this.responseActive = true;
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  stop() {
    if (this.session) this.log("session.stopped");
    const session = this.session;
    this.session = null;
    this.nonce = null;
    this.toolChain = Promise.resolve();
    this.responseActive = false;
    this.responsePending = false;
    this.pendingNotices.clear();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.userSpeaking = false;
    if (session) {
      session.dc?.close();
      session.pc.close();
      for (const track of session.stream.getTracks()) track.stop();
      session.audio.srcObject = null;
      session.audio.remove();
    }
    this.setState("idle");
  }

  private async handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>) {
    const bindings = this.bindings;
    const name = String(event.name ?? "");
    const callId = String(event.call_id ?? "");
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(typeof event.arguments === "string" ? event.arguments : "{}");
    } catch {
      /* keep {} */
    }
    this.log("tool.call", { name, args });
    let output: string;
    if (!bindings) {
      output = "Tool error: no bb surface is bound right now.";
    } else if (name === "set_composer_text") {
      bindings.composer.setText(String(args.text ?? ""));
      output = "Composer text replaced.";
    } else if (name === "append_composer_text") {
      const text = String(args.text ?? "");
      bindings.composer.updateText((current) => (current ? `${current}\n${text}` : text));
      output = "Text appended to composer.";
    } else if (
      name === "start_thread" &&
      !(typeof args.prompt === "string" && args.prompt.trim())
    ) {
      // No dictated prompt: never fabricate one — open bb's New thread screen
      // with the project preselected and let the user type it themselves.
      const projectId =
        typeof args.project_id === "string" && args.project_id
          ? args.project_id
          : bindings.context.projectId;
      bindings.openNewThread(projectId);
      output =
        "Opened the New thread screen with the project preselected. The user will type the prompt themselves; no thread exists yet.";
    } else {
      try {
        const result = await bindings.rpc.call("runTool", {
          name,
          args,
          ...bindings.context,
        });
        output = result.output;
      } catch (error) {
        output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.log("tool.result", { name, output: output.slice(0, 4000) });
    if (!callId || dc.readyState !== "open") return;
    // Creating the output item is always safe; only response.create must wait.
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
    this.requestResponse(dc);
  }

  private async start() {
    const bindings = this.bindings;
    if (!bindings) return;
    this.setState("connecting");
    const nonce = crypto.randomUUID();
    this.nonce = nonce;
    this.log("session.started", { ...bindings.context });
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioCaptureConstraint(this.audioPreferences.inputDeviceId),
        });
      } catch (error) {
        if (
          !this.audioPreferences.inputDeviceId ||
          !shouldRetryWithDefaultDevice(error)
        ) throw error;
        this.setAudioPreferences({ ...this.audioPreferences, inputDeviceId: "" });
        toast.info("Aide: selected microphone unavailable; using system default");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const pc = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      const session: SessionHandle = { pc, stream, audio, dc: null };
      this.session = session;
      const setSinkId = (audio as HTMLAudioElement & {
        setSinkId?: (deviceId: string) => Promise<void>;
      }).setSinkId;
      if (this.audioPreferences.outputDeviceId && setSinkId) {
        try {
          await setSinkId.call(audio, this.audioPreferences.outputDeviceId);
        } catch {
          if (this.session?.pc !== pc) return;
          this.setAudioPreferences({ ...this.audioPreferences, outputDeviceId: "" });
          toast.info("Aide: selected speaker unavailable; using system default");
        }
      }
      if (this.session?.pc !== pc) return;

      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => undefined);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          if (this.session?.pc === pc) {
            toast.error("Aide: voice connection lost");
            this.stop();
          }
        }
      };

      const dc = pc.createDataChannel("oai-events");
      session.dc = dc;
      dc.onopen = () => {
        if (this.session?.pc === pc) {
          this.setState("live");
          this.log("session.live");
        }
      };
      dc.onmessage = (message) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const type = String(event.type ?? "");
        if (type === "response.created") {
          this.responseActive = true;
        } else if (type === "input_audio_buffer.speech_started") {
          this.userSpeaking = true;
        } else if (type === "input_audio_buffer.speech_stopped") {
          this.userSpeaking = false;
          if (this.pendingNotices.size > 0) this.scheduleNoticeDrain();
        } else if (type === "response.function_call_arguments.done") {
          this.toolChain = this.toolChain
            .then(() => this.handleToolCall(dc, event))
            .catch(() => undefined);
        } else if (type === "conversation.item.input_audio_transcription.completed") {
          const text = String(event.transcript ?? "").trim();
          if (text) this.log("user", { text });
        } else if (
          type === "response.output_audio_transcript.done" ||
          type === "response.audio_transcript.done"
        ) {
          const text = String(event.transcript ?? "").trim();
          if (text) this.log("assistant", { text });
        } else if (type === "response.done") {
          this.responseActive = false;
          if (this.responsePending) {
            this.responsePending = false;
            this.requestResponse(dc);
          } else if (this.pendingNotices.size > 0) {
            this.scheduleNoticeDrain(1000);
          }
          const response = event.response as Record<string, unknown> | undefined;
          const usage = response?.usage;
          if (usage && typeof usage === "object") {
            void this.bindings?.rpc
              .call("recordUsage", {
                model: typeof response?.model === "string" ? response.model : null,
                sessionId: this.nonce,
                usage: usage as Record<string, unknown>,
              })
              .catch(() => undefined); // cost tracking must never break the call
          }
        } else if (type === "error") {
          const detail = (event.error as { message?: string } | undefined)?.message;
          this.log("error", { message: detail ?? "realtime error" });
          toast.error(`Aide: ${detail ?? "realtime error"}`);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) throw new Error("No local SDP offer");

      const { sdp } = await bindings.rpc.call("createCall", {
        sdp: localSdp,
        nonce,
        ...bindings.context,
      });
      if (this.session?.pc !== pc) return; // stopped while exchanging
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      this.stop();
      toast.error(`Aide: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export const voiceAgent = new VoiceAgent();
