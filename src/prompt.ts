import type { Plugin } from "@opencode/plugin";
import { Confirm } from "./rpc.js";

/** Long enough to come back to the terminal; short enough that a forgotten prompt does not pin the call. */
export const PROMPT_TIMEOUT_MS = 10 * 60_000;

export interface ConfirmRequest {
  sessionID: string;
  permission: string;
  summary: string;
  signal: AbortSignal;
}

export interface Prompter {
  /** Resolves on approval. Every other outcome throws, and none of them lets the write through. */
  confirm(request: ConfirmRequest): Promise<void>;
}

/**
 * The server half of `rpc.ts`. It fails closed on every path: with no TUI attached there is nobody
 * to ask, so the call is refused at once rather than left waiting — `opencode run` and a bare
 * `serve` land here. An attached TUI that never answers runs into the timeout, the last TUI
 * detaching refuses what it left open, and an aborted tool call withdraws its question. Only an explicit approval resolves.
 */
export async function createPrompter(
  rpc: Plugin.Context["rpc"],
  timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<Prompter> {
  let attached = 0;
  const pending = new Map<string, { answer(approved: boolean): void; abandon(): void }>();
  const registration = await rpc.register(Confirm, {
    attach: async (_input, { signal }) => {
      attached++;
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        // The last TUI is gone, so nothing can answer what is still open: refuse it now rather
        // than leave the tool call waiting out the timeout.
        if (--attached === 0) for (const open of pending.values()) open.abandon();
      }
      return "closed" as const;
    },
    reply: async ({ requestID, approved }) => {
      const open = pending.get(requestID);
      if (!open) return false;
      pending.delete(requestID);
      open.answer(approved);
      return true;
    },
  });

  return {
    async confirm({ sessionID, permission, summary, signal }) {
      signal.throwIfAborted();
      if (!attached) {
        throw new Error(
          `${permission} needs your confirmation, and no opencode TUI is attached to ask it in — nothing was done`,
        );
      }
      const requestID = crypto.randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const approved = await new Promise<boolean>((resolve, reject) => {
          pending.set(requestID, {
            answer: resolve,
            abandon: () =>
              reject(
                new Error(
                  `${permission} lost its opencode TUI before an answer — nothing was done`,
                ),
              ),
          });
          const minutes = Math.round(timeoutMs / 60_000);
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${permission} was not confirmed within ${minutes} min — nothing was done`,
                ),
              ),
            timeoutMs,
          );
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          registration.events
            .emit("request", { requestID, sessionID, permission, summary })
            .catch(reject);
        });
        if (!approved) throw new Error(`${permission} was declined by the user — nothing was done`);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        pending.delete(requestID);
        // Closes the dialog in every other TUI, and in this one too when it never got an answer.
        await registration.events.emit("settled", { requestID }).catch(() => {});
      }
    },
  };
}
