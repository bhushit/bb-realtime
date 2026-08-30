export interface AudioDeviceLike {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
}

export interface AudioDevicePreferences {
  inputDeviceId: string;
  outputDeviceId: string;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
}

const STORAGE_KEY = "bb-realtime.audio-devices";
const DEFAULT_PREFERENCES: AudioDevicePreferences = {
  inputDeviceId: "",
  outputDeviceId: "",
};

export function readAudioDevicePreferences(storage: PreferenceStorage): AudioDevicePreferences {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    return {
      inputDeviceId: typeof parsed?.inputDeviceId === "string" ? parsed.inputDeviceId : "",
      outputDeviceId: typeof parsed?.outputDeviceId === "string" ? parsed.outputDeviceId : "",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeAudioDevicePreferences(
  storage: PreferenceStorage,
  preferences: AudioDevicePreferences,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function audioCaptureConstraint(deviceId: string): true | MediaTrackConstraints {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

export function resolveDeviceId(
  preferredId: string,
  devices: readonly AudioDeviceLike[],
): string {
  if (!preferredId) return "";
  return devices.some((device) => device.deviceId === preferredId) ? preferredId : "";
}

export function shouldRetryWithDefaultDevice(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";
  return name === "OverconstrainedError" || name === "NotFoundError";
}

export function deviceDisplayLabel(device: AudioDeviceLike, index: number): string {
  if (device.label) return device.label;
  return `${device.kind === "audioinput" ? "Microphone" : "Speaker"} ${index + 1}`;
}
