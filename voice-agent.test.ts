import test from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent } from "./voice-agent.ts";
import { writeAudioDevicePreferences } from "./audio-devices.ts";

test("reloads audio preferences saved by another browser window", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });

  try {
    const agent = new VoiceAgent();
    writeAudioDevicePreferences(storage, {
      inputDeviceId: "mic-from-window-a",
      outputDeviceId: "speaker-from-window-a",
    });

    agent.refreshAudioPreferences();

    assert.deepEqual(agent.getAudioPreferences(), {
      inputDeviceId: "mic-from-window-a",
      outputDeviceId: "speaker-from-window-a",
    });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test("stopping during speaker routing closes the mic and cancels startup", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let resolveSink!: () => void;
  let announceSinkStarted!: () => void;
  const sinkStarted = new Promise<void>((resolve) => {
    announceSinkStarted = resolve;
  });
  const sinkPending = new Promise<void>((resolve) => {
    resolveSink = resolve;
  });
  let peer: FakePeerConnection | null = null;

  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    closed = false;
    createOfferCalls = 0;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;

    constructor() {
      peer = this;
    }

    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.closed = true;
    }
    createDataChannel() {
      return { readyState: "connecting", close() {}, send() {}, onopen: null, onmessage: null };
    }
    async createOffer() {
      this.createOfferCalls += 1;
      return { type: "offer" as const, sdp: "offer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription() {}
  }

  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async setSinkId() {
      announceSinkStarted();
      return sinkPending;
    }
    async play() {}
    remove() {}
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
  });
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: FakeAudio,
  });

  const agent = new VoiceAgent();
  agent.bind({
    rpc: {
      call: (async (method: string) =>
        method === "createCall" ? { sdp: "answer" } : { ok: true }) as never,
    },
    context: { threadId: null, projectId: null },
    composer: { setText() {}, updateText() {} },
    openNewThread() {},
  });
  agent.setAudioPreferences({ inputDeviceId: "", outputDeviceId: "speaker-1" });

  try {
    agent.toggle();
    await sinkStarted;
    agent.stop();

    assert.equal(track.stopped, true);
    assert.equal(peer?.closed, true);

    resolveSink();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peer?.createOfferCalls, 0);
    assert.equal(agent.getState(), "idle");
  } finally {
    resolveSink();
    agent.stop();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
    else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
    else delete (globalThis as { Audio?: unknown }).Audio;
  }
});
