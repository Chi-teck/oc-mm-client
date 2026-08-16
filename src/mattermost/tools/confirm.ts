import type { ToolContext } from "@opencode-ai/plugin";

export async function confirmWrite(
  tctx: ToolContext,
  permission: string,
  summary: string,
): Promise<void> {
  await tctx.ask({
    permission,
    patterns: [summary],
    always: [],
    metadata: { summary },
  });
}
