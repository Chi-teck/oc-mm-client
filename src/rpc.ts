import type { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

/**
 * The line between the server plugin, which runs the tools, and the TUI plugin, which is the only
 * side that can put a question in front of a human: opencode v2 gives a server plugin no prompt of
 * its own. Loaded by both, so it holds nothing but the definition.
 *
 * - `attach` is held open by every TUI for as long as it runs. It is how the server knows whether
 *   anybody could answer at all, and so whether to ask or to refuse on the spot.
 * - `request` goes to every attached TUI; `reply` answers it, and only the first reply counts.
 * - `settled` closes the question wherever it is still open — answered in another TUI, timed out,
 *   or abandoned because the tool call was aborted.
 */
export const Confirm = {
  id: "oc-mm-client.confirm",
  methods: {
    attach: { input: z.object({}), output: z.literal("closed") },
    reply: {
      input: z.object({ requestID: z.string(), approved: z.boolean() }),
      output: z.boolean(),
    },
  },
  events: {
    request: {
      schema: z.object({
        requestID: z.string(),
        sessionID: z.string(),
        permission: z.string(),
        summary: z.string(),
      }),
    },
    settled: { schema: z.object({ requestID: z.string() }) },
  },
} satisfies Rpc.PortableDefinition;
