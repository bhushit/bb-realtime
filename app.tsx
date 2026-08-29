// bb-plugin-aide — frontend: a voice-agent toggle in the composer.
//
// A circular waveform button rendered beside the native mic/submit controls.
// Clicking it opens a WebRTC session with the OpenAI Realtime API (mic capture
// and audio playback happen right here in the bb app); the backend performs
// the SDP exchange (it holds the API key) and executes bb tools via bb.sdk.
import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { cn } from "@/lib/utils";
import "./app.css";

type VoiceState = "idle" | "connecting" | "live";

interface SessionHandle {
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  dc: RTCDataChannel | null;
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

function AideVoiceButton() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const { threadId, projectId } = useBbContext();
  const [state, setState] = useState<VoiceState>("idle");
  const sessionRef = useRef<SessionHandle | null>(null);
  // Live context for tool calls — the user may navigate while talking.
  const contextRef = useRef({ threadId, projectId });
  contextRef.current = { threadId, projectId };
  const composerRef = useRef(composer);
  composerRef.current = composer;

  function stop() {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      session.dc?.close();
      session.pc.close();
      for (const track of session.stream.getTracks()) track.stop();
      session.audio.srcObject = null;
      session.audio.remove();
    }
    setState("idle");
  }

  useEffect(() => stop, []);

  async function handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>) {
    const name = String(event.name ?? "");
    const callId = String(event.call_id ?? "");
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(typeof event.arguments === "string" ? event.arguments : "{}");
    } catch {
      /* keep {} */
    }
    let output: string;
    if (name === "set_composer_text") {
      composerRef.current.setText(String(args.text ?? ""));
      output = "Composer text replaced.";
    } else if (name === "append_composer_text") {
      const text = String(args.text ?? "");
      composerRef.current.updateText((current) => (current ? `${current}\n${text}` : text));
      output = "Text appended to composer.";
    } else {
      try {
        const result = await rpc.call("runTool", { name, args, ...contextRef.current });
        output = result.output;
      } catch (error) {
        output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!callId) return;
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  async function start() {
    setState("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const pc = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      const session: SessionHandle = { pc, stream, audio, dc: null };
      sessionRef.current = session;

      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => undefined);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          if (sessionRef.current?.pc === pc) {
            toast.error("BB Aide: voice connection lost");
            stop();
          }
        }
      };

      const dc = pc.createDataChannel("oai-events");
      session.dc = dc;
      dc.onopen = () => {
        if (sessionRef.current?.pc === pc) setState("live");
      };
      dc.onmessage = (message) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const type = String(event.type ?? "");
        if (type === "response.function_call_arguments.done") {
          void handleToolCall(dc, event);
        } else if (type === "error") {
          const detail = (event.error as { message?: string } | undefined)?.message;
          toast.error(`BB Aide: ${detail ?? "realtime error"}`);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) throw new Error("No local SDP offer");

      const { sdp } = await rpc.call("createCall", {
        sdp: localSdp,
        threadId: contextRef.current.threadId,
        projectId: contextRef.current.projectId,
      });
      if (sessionRef.current?.pc !== pc) return; // stopped while exchanging
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      stop();
      toast.error(`BB Aide: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const live = state === "live";
  return (
    <button
      type="button"
      aria-label={live ? "Stop BB Aide voice agent" : "Start BB Aide voice agent"}
      title={live ? "Stop BB Aide" : "Talk to BB Aide"}
      onClick={() => (state === "idle" ? void start() : stop())}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors",
        state === "idle" &&
          "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        state === "connecting" && "animate-pulse border-primary/50 text-primary",
        live && "border-primary bg-primary/15 text-primary",
      )}
    >
      <WaveformIcon live={live} />
    </button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "aide-voice",
    actions: [{ id: "voice-agent", component: AideVoiceButton }],
  });
});
