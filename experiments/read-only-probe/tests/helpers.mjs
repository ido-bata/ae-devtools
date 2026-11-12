/**
 * Fake responder helpers shared by probe tests: build a channel, watch the
 * inbox, publish results by rename exactly like the real ES3 host.
 *
 * NOTE on fs.watch: it is asynchronous and may fire after the spawned
 * probe.mjs already wrote the request, which is fine; but on some systems
 * events are coalesced. Tests that need determinism poll the inbox with
 * a small busy loop instead (see awaitRequest()).
 */
import { mkdirSync, readdirSync, rmSync, watch, writeFileSync, renameSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TOKEN = "abcdef0123456789".repeat(4);   // must satisfy /^[a-f0-9]{64}$/
export const CHANNEL_ID = "chan-cccccccc";

export function makeChannel(root, { token = TOKEN, channelId = CHANNEL_ID, expectedAeVersion = "" } = {}) {
  const channel = join(root, "chan");
  mkdirSync(channel, { mode: 0o700 });
  mkdirSync(join(channel, "inbox"), { mode: 0o700 });
  mkdirSync(join(channel, "outbox"), { mode: 0o700 });
  writeFileSync(join(channel, "probe.json"), JSON.stringify({
    version: 1, token, channelId,
    expectedAeVersion,
    createdAt: new Date().toISOString(),
  }) + "\n", { mode: 0o600 });
  writeFileSync(join(channel, "ids.json"), JSON.stringify({ burned: [] }) + "\n", { mode: 0o600 });
  return { channel, token, channelId };
}

export function requestIdInbox(channel) {
  return readdirSync(join(channel, "inbox"))
    .filter((f) => f.endsWith(".request.json"))
    .map((f) => f.replace(".request.json", ""));
}

/** Wait until a request file appears in the inbox (bounded). */
export async function awaitRequest(channel, maxMs = 5000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const ids = requestIdInbox(channel);
    if (ids.length > 0) return ids[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no request appeared in the inbox before the wait bound");
}

/** Publish a result by rename — same publication rule as the ES3 host. */
export function publishResult(channel, id, reply) {
  const part = join(channel, "outbox", id + ".result.json.part");
  writeFileSync(part, JSON.stringify(reply));
  renameSync(part, join(channel, "outbox", id + ".result.json"));
}

/** Publish arbitrary RAW text as the result (for unreadable-reply tests). */
export function publishRawResult(channel, id, raw) {
  const part = join(channel, "outbox", id + ".result.json.part");
  writeFileSync(part, raw);
  renameSync(part, join(channel, "outbox", id + ".result.json"));
}

/** A watcher that answers requests with buildReply(id). Returns a stop() function. */
export function fakeResponder(channel, buildReply) {
  const timer = setInterval(async () => {
    try {
      const ids = requestIdInbox(channel);
      for (const id of ids) {
        publishResult(channel, id, buildReply(id));
      }
    } catch {
      // channel may have been removed by cleanup
    }
  }, 20);
  return () => clearInterval(timer);
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

export function readChannelJson(channel, name) {
  return JSON.parse(readFileSync(join(channel, name), "utf8"));
}

export function channelExists(channel) {
  return existsSync(channel);
}
