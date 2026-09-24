import type { Plugin } from "@opencode/plugin/tui";
import { Confirm } from "./rpc.js";

/** How long to wait before attaching again after the server side went away — a reload, a restart. */
const REATTACH_MS = 2_000;

/**
 * The TUI half of `rpc.ts`: the confirmation dialog `mattermost_create_post` and the other writes
 * wait on. opencode loads it next to `index.ts` for as long as that plugin is active.
 *
 * Questions are shown one at a time, in the order they came: a second dialog would replace the
 * first, and the first would read as declined. One that settled while still queued is skipped.
 */
export default {
  id: "oc-mm-client",
  setup(ctx) {
    const rpc = ctx.client.rpc(Confirm);
    const controller = new AbortController();
    const { signal } = controller;
    const location = ctx.location;
    const waiting = new Set<string>();
    let showing: string | undefined;
    let queue = Promise.resolve();

    // Held open for the life of the TUI; the server counts these to know whether anyone can answer.
    void (async () => {
      while (!signal.aborted) {
        await rpc.attach({}, { signal, location }).catch(() => undefined);
        if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, REATTACH_MS));
      }
    })();

    const ask = async (event: { requestID: string; permission: string; summary: string }) => {
      if (!waiting.has(event.requestID)) return;
      showing = event.requestID;
      const approved = await ctx.ui.dialog.confirm({
        title: `Mattermost: ${event.permission}`,
        message: event.summary,
        label: { confirm: "Allow", cancel: "Deny" },
      });
      showing = undefined;
      // Settled while open — answered elsewhere, or withdrawn — and the dialog was closed for it.
      if (!waiting.delete(event.requestID)) return;
      await rpc
        .reply({ requestID: event.requestID, approved: approved === true }, { location })
        .catch(() => undefined);
    };

    rpc.events.on(
      "request",
      (event) => {
        // One server serves every project; a question from another one is not this TUI's to answer.
        if (location && event.location.directory !== location.directory) return;
        waiting.add(event.data.requestID);
        queue = queue.then(() => ask(event.data)).catch(() => undefined);
      },
      { signal },
    );
    rpc.events.on(
      "settled",
      (event) => {
        if (!waiting.delete(event.data.requestID)) return;
        if (showing === event.data.requestID) ctx.ui.dialog.clear();
      },
      { signal },
    );

    return () => controller.abort();
  },
} satisfies Plugin.Definition;
