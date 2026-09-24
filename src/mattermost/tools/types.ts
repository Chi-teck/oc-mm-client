import type { z } from "zod";

/**
 * What a tool gets from whoever runs it. Neither entry point hands over its host's own context: the
 * plugin and the CLI need a different `confirm` above all, and keeping the tools off opencode's types
 * is what lets `src/cli.ts` run them without opencode at all.
 */
export interface MmToolContext {
  signal: AbortSignal;
  /** Resolves once the write is approved; throws when it is declined or nobody can be asked. */
  confirm(permission: string, summary: string): Promise<void>;
}

export type MmToolResult = string | { title?: string; output: string };

export interface MmTool<Input extends z.ZodObject = z.ZodObject> {
  description: string;
  input: Input;
  execute(input: z.output<Input>, tctx: MmToolContext): Promise<MmToolResult>;
}

/** Infers `execute`'s argument from `input`, then forgets it, so every tool fits one map. */
export function tool<Input extends z.ZodObject>(definition: MmTool<Input>): MmTool {
  return definition as unknown as MmTool;
}
