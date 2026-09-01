// Stable identity for observability across bb's per-surface realms and connect
// clients. The plugin SDK exposes no client/device/connection id (BbContext is
// just { projectId, threadId }), so we mint our own and stamp it onto events and
// presence — this is how we can finally see "which client / which realm is this
// happening from" when a call is mirrored and controlled across surfaces and
// devices.
//
//   - clientId: persisted in localStorage → stable per browser/device. Survives
//     reloads and navigation; shared by same-origin surfaces on one device, so
//     it reads as "this client/device". Different on a phone viewing over connect.
//   - realmId:  fresh per module load → identifies THIS realm/surface instance.
//     A single device holds several (composer, sidebar, page), so this is what
//     exposes the multi-realm behavior behind the mobile call bugs.
//
// Both are best-effort: no localStorage or no crypto simply degrades to an
// in-memory id (still useful within a session).

const CLIENT_ID_KEY = "bb-handsfree:client-id";

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

function readOrMintClientId(): string {
  try {
    const store = typeof window === "undefined" ? null : window.localStorage;
    if (!store) return randomId();
    const existing = store.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const minted = randomId();
    store.setItem(CLIENT_ID_KEY, minted);
    return minted;
  } catch {
    return randomId();
  }
}

/** Stable per browser/device (localStorage-backed). */
export const clientId = readOrMintClientId();

/** Fresh per realm/surface load (in-memory). */
export const realmId = randomId();

/** Compact identity to merge into event/presence payloads. */
export function identityTag(): { client: string; realm: string } {
  return { client: clientId, realm: realmId };
}
