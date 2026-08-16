#!/usr/bin/env bun
import { type ToolContext, type ToolDefinition, tool } from "@opencode-ai/plugin";
import { createMattermostContext } from "./mattermost/context.js";
import { loadEnvFile, type MattermostEnv, readMattermostEnv } from "./mattermost/env.js";
import { createTools } from "./mattermost/tools/registry.js";

type ToolMap = Record<string, ToolDefinition>;
type ArgSchema = ToolDefinition["args"][string];

const PREFIX = "mattermost_";
// `--help` only prints tool names, args and descriptions — no server is contacted, so blank
// credentials are enough to build the tool map.
const PLACEHOLDER: MattermostEnv = { url: "", token: "", team: "" };

export interface ParsedArgv {
  name: string | undefined;
  pairs: string[];
  approve: boolean;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const approve = argv.includes("--yes");
  const rest = argv.filter((arg) => arg !== "--yes");
  return { name: rest[0], pairs: rest.slice(1), approve };
}

function accepts(schema: ArgSchema, value: unknown): boolean {
  return tool.schema.object({ value: schema }).safeParse({ value }).success;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Turns the raw strings collected for one `key=value` argument into a value its schema accepts.
 * Candidates are tried in order — the raw string (or the collected list when the key repeats),
 * its JSON parse, then a one-element array — and the first the schema accepts wins. When nothing
 * fits, the JSON parse is preferred over the raw text so the schema error names the real problem:
 * `limit=201` is a number that is too big, not a string.
 */
export function coerce(schema: ArgSchema | undefined, values: string[]): unknown {
  const single = values.length === 1;
  const first = values[0] ?? "";
  const candidates: unknown[] = [single ? first : values];
  const json = single
    ? parseJson(first)
    : values.reduce<{ ok: true; value: unknown[] } | { ok: false }>(
        (acc, value) => {
          if (!acc.ok) return acc;
          const parsed = parseJson(value);
          return parsed.ok ? { ok: true, value: [...acc.value, parsed.value] } : { ok: false };
        },
        { ok: true, value: [] },
      );
  if (json.ok) candidates.push(json.value);
  if (single) candidates.push([first]);
  if (!schema) return candidates[0];
  const fallback = json.ok ? json.value : candidates[0];
  return candidates.find((candidate) => accepts(schema, candidate)) ?? fallback;
}

export function parseToolArgs(
  pairs: string[],
  shape: ToolDefinition["args"],
): Record<string, unknown> {
  const grouped = new Map<string, string[]>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`expected key=value, got: ${pair}`);
    const key = pair.slice(0, eq);
    grouped.set(key, [...(grouped.get(key) ?? []), pair.slice(eq + 1)]);
  }
  const args: Record<string, unknown> = {};
  for (const [key, values] of grouped) args[key] = coerce(shape[key], values);
  return args;
}

export function resolveTool(tools: ToolMap, name: string): ToolDefinition | undefined {
  return tools[name] ?? tools[`${PREFIX}${name}`];
}

export function usage(tools: ToolMap): string {
  const lines = [
    "usage: mm-oc <tool> [key=value ...] [--yes]",
    "",
    `The ${PREFIX} prefix is optional. Write tools need --yes; reads run unprompted.`,
    "Repeat a key to build a list: attachments=a.txt attachments=b.txt",
    "",
  ];
  for (const [id, def] of Object.entries(tools)) {
    const args = Object.entries(def.args).map(([key, schema]) =>
      // A schema that accepts `undefined` is an optional arg.
      accepts(schema, undefined) ? `[${key}]` : key,
    );
    lines.push(`  ${id} ${args.join(" ")}`.trimEnd());
    lines.push(`      ${def.description}`);
  }
  return lines.join("\n");
}

function cliContext(approve: boolean): ToolContext {
  const cwd = process.cwd();
  return {
    sessionID: "cli",
    messageID: "cli",
    agent: "cli",
    directory: cwd,
    worktree: cwd,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async (input) => {
      const summary = input.patterns[0] ?? input.permission;
      if (!approve) throw new Error(`permission required: ${summary} — re-run with --yes`);
      console.error(`[approved] ${summary}`);
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  const { name, pairs, approve } = parseArgv(argv);
  if (!name || name === "--help" || name === "-h") {
    const help = usage(createTools(createMattermostContext(PLACEHOLDER)));
    // Asking for help succeeds on stdout; running with no tool at all is a usage error.
    if (name) {
      console.log(help);
      return 0;
    }
    console.error(help);
    return 1;
  }

  loadEnvFile();
  const tools = createTools(createMattermostContext(readMattermostEnv()));
  const def = resolveTool(tools, name);
  if (!def) {
    console.error(`unknown tool: ${name}\n\n${usage(tools)}`);
    return 1;
  }

  const parsed = tool.schema.strictObject(def.args).safeParse(parseToolArgs(pairs, def.args));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(args)"}: ${issue.message}`)
      .join("; ");
    console.error(`invalid arguments for ${name}: ${issues}`);
    return 1;
  }

  const result = await def.execute(parsed.data, cliContext(approve));
  if (typeof result === "string") {
    console.log(result);
    return 0;
  }
  if (result.title) console.log(`## ${result.title}\n`);
  console.log(result.output);
  return 0;
}

if (import.meta.main) {
  process.exit(
    await main(process.argv.slice(2)).catch((error: unknown) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }),
  );
}
