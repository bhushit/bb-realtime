import test from "node:test";
import assert from "node:assert/strict";
import {
  audioCaptureConstraint,
  deviceDisplayLabel,
  readAudioDevicePreferences,
  shouldRetryWithDefaultDevice,
  writeAudioDevicePreferences,
} from "./audio-devices.ts";

test("uses the browser default microphone when no preference is saved", () => {
  assert.equal(audioCaptureConstraint(""), true);
});

test("requests a saved microphone by exact device id", () => {
  assert.deepEqual(audioCaptureConstraint("input-123"), {
    deviceId: { exact: "input-123" },
  });
});

test("provides readable labels before browser permission reveals device names", () => {
  assert.equal(
    deviceDisplayLabel({ deviceId: "in", kind: "audioinput", label: "" }, 2),
    "Microphone 3",
  );
  assert.equal(
    deviceDisplayLabel({ deviceId: "out", kind: "audiooutput", label: "" }, 0),
    "Speaker 1",
  );
});

test("persists browser-local audio preferences", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(writeAudioDevicePreferences(storage, {
    inputDeviceId: "input-123",
    outputDeviceId: "output-456",
  }), true);

  assert.deepEqual(readAudioDevicePreferences(storage), {
    inputDeviceId: "input-123",
    outputDeviceId: "output-456",
  });
});

test("keeps storage failures from breaking in-memory device selection", () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("Storage denied", "SecurityError");
    },
  };

  assert.equal(writeAudioDevicePreferences(storage, {
    inputDeviceId: "input-123",
    outputDeviceId: "output-456",
  }), false);
});

test("ignores invalid persisted audio preferences", () => {
  const storage = {
    getItem: () => "not json",
    setItem: () => undefined,
  };

  assert.deepEqual(readAudioDevicePreferences(storage), {
    inputDeviceId: "",
    outputDeviceId: "",
  });
});

test("only retries capture failures caused by an unavailable selected device", () => {
  assert.equal(shouldRetryWithDefaultDevice({ name: "OverconstrainedError" }), true);
  assert.equal(shouldRetryWithDefaultDevice({ name: "NotFoundError" }), true);
  assert.equal(shouldRetryWithDefaultDevice({ name: "NotAllowedError" }), false);
  assert.equal(shouldRetryWithDefaultDevice(new Error("unknown")), false);
});
