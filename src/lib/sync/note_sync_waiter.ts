import { normalizePath } from "obsidian";

import { dump } from "../utils/helpers";

interface Waiter {
  resolve: (ok: boolean) => void;
  timer: number;
}

const waiters: Map<string, Set<Waiter>> = new Map();

/**
 * Wait until the server acknowledges a note upload (NoteModifyAck) for the given path.
 * Resolves `false` on timeout or when the plugin unloads. `timeoutMs <= 0` waits indefinitely.
 */
export function waitForNoteSynced(path: string, timeoutMs = 8000): Promise<boolean> {
  const key = normalizePath(path);
  return new Promise((resolve) => {
    const set = waiters.get(key) ?? new Set<Waiter>();
    const waiter: Waiter = { resolve, timer: 0 };
    if (timeoutMs > 0) {
      waiter.timer = window.setTimeout(() => {
        dump(`NoteSyncWaiter: timeout waiting for ack of ${key}`);
        settle(key, waiter, false);
      }, timeoutMs);
    }
    set.add(waiter);
    waiters.set(key, set);
  });
}

/** Called when a NoteModifyAck arrives for `path`; resolves every waiter for that path. */
export function notifyNoteSynced(path: string): void {
  const key = normalizePath(path);
  const set = waiters.get(key);
  if (!set || set.size === 0) return;
  for (const waiter of Array.from(set)) settle(key, waiter, true);
}

/** Resolve all pending waiters as failed (used on plugin unload / disconnect). */
export function cancelAllNoteSyncWaiters(): void {
  for (const [key, set] of Array.from(waiters.entries())) {
    for (const waiter of Array.from(set)) settle(key, waiter, false);
  }
}

function settle(key: string, waiter: Waiter, ok: boolean): void {
  if (waiter.timer) window.clearTimeout(waiter.timer);
  const set = waiters.get(key);
  if (set) {
    set.delete(waiter);
    if (set.size === 0) waiters.delete(key);
  }
  waiter.resolve(ok);
}
