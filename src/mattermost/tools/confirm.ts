import type { MmToolContext } from "./types.js";

export async function confirmWrite(
  tctx: MmToolContext,
  permission: string,
  summary: string,
): Promise<void> {
  await tctx.confirm(permission, summary);
}
