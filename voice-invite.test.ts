import test from "node:test";
import assert from "node:assert/strict";
import { inviteStore } from "./voice-invite.ts";

function invite(overrides = {}) {
  const now = Date.now();
  return {
    inviteId: "inv-test-1",
    title: "Morning brief",
    briefing: "Plan the day",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

test("ingests a valid invite and dismisses it", () => {
  try {
    assert.equal(inviteStore.getSnapshot(), null);
    assert.equal(inviteStore.ingestInvite(invite()), true);
    assert.equal(inviteStore.getSnapshot()?.title, "Morning brief");
    inviteStore.dismiss();
    assert.equal(inviteStore.getSnapshot(), null);
  } finally {
    inviteStore.reset();
  }
});

test("ignores malformed and already-expired invites", () => {
  try {
    assert.equal(inviteStore.ingestInvite(null), false);
    assert.equal(inviteStore.ingestInvite({ inviteId: "x" }), false);
    assert.equal(inviteStore.ingestInvite(invite({ expiresAt: Date.now() - 1000 })), false);
    assert.equal(inviteStore.getSnapshot(), null);
  } finally {
    inviteStore.reset();
  }
});

test("the latest invite replaces a ringing one and expiry goes quiet", async () => {
  try {
    assert.equal(inviteStore.ingestInvite(invite({ inviteId: "inv-1" })), true);
    assert.equal(inviteStore.ingestInvite(invite({ inviteId: "inv-2" })), true);
    assert.equal(inviteStore.getSnapshot()?.inviteId, "inv-2");
    assert.equal(inviteStore.ingestInvite(invite({ inviteId: "inv-3", expiresAt: Date.now() + 30 })), true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(inviteStore.getSnapshot(), null);
  } finally {
    inviteStore.reset();
  }
});

test("snooze hides the invite and rings again shortly after", async () => {
  try {
    assert.equal(inviteStore.ingestInvite(invite()), true);
    inviteStore.snooze(0.001); // ~60ms
    assert.equal(inviteStore.getSnapshot(), null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(inviteStore.getSnapshot()?.inviteId, "inv-test-1");
  } finally {
    inviteStore.reset();
  }
});
