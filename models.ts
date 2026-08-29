// Shared between server.ts and the frontend (plain data, no dependencies).
export const MODEL_OPTIONS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;
export type RealtimeModel = (typeof MODEL_OPTIONS)[number];
export const DEFAULT_MODEL: RealtimeModel = "gpt-realtime-2.1";
