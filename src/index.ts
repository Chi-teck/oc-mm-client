import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMattermostClient } from "./mattermost/client.js";
import { createMattermostContext, withTimeout } from "./mattermost/context.js";
import { loadEnvFile, type MattermostEnv, readMattermostEnv } from "./mattermost/env.js";
import { createTools, describeClientError } from "./mattermost/tools/registry.js";

const STARTUP_TIMEOUT_MS = 10_000;

function strOption(options: PluginOptions | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Not `console.error`: opencode captures nothing a plugin writes to stdout or stderr. In the TUI the
 * text is painted into the frame the interface is about to repaint — a flicker at startup, torn
 * output later — and it reaches no log file at all. This goes to opencode's own log, where
 * `--print-logs` and `log/opencode.log` can find it. The service name is not rendered in the log
 * line, so the message keeps carrying the plugin's name.
 */
function log(input: PluginInput, level: "warn" | "error", message: string) {
  return input.client.app.log({ body: { service: "oc-mm-client", level, message } });
}

/**
 * The option is a path relative to the project directory — resolved there rather than against the
 * process cwd for the same reason `.env.local` is, one comment below. A directory outside the
 * worktree is refused: opencode resolves `read` permissions against it, so a file saved elsewhere is
 * one the caller cannot open afterwards. A configuration mistake, unlike a missing credential, leaves
 * the plugin working: say so and keep the default.
 */
async function resolveDownloadDir(
  value: string | undefined,
  input: PluginInput,
): Promise<string | undefined> {
  if (!value) return undefined;
  const resolved = resolve(input.directory, value);
  // The worktree, not the session directory: `read` permissions are resolved against it, and it is
  // the wider of the two when opencode is started inside a subdirectory.
  const root = input.worktree ?? input.directory;
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    await log(
      input,
      "warn",
      `oc-mm-client: ignoring downloadDir ${value} — it resolves to ${resolved}, outside ${root}; using the default .opencode/mm-files`,
    );
    return undefined;
  }
  return resolved;
}

export default (async (input, options) => {
  // Anchored to the project directory, not the process cwd: `opencode run --dir=<project>` leaves
  // the cwd wherever it was launched, and a relative path would miss the project's `.env.local`.
  const fileEnv = loadEnvFile(join(input.directory, ".env.local"));
  let env: MattermostEnv | undefined;
  try {
    env = readMattermostEnv({ ...fileEnv, ...process.env });
  } catch {
    // Incomplete env is not fatal here: plugin options can supply what is missing.
    env = undefined;
  }
  const url = strOption(options, "url") ?? env?.url;
  const token = strOption(options, "token") ?? env?.token;
  const team = strOption(options, "team") ?? env?.team;
  if (!url || !token || !team) {
    await log(
      input,
      "error",
      "oc-mm-client disabled: set OC_MM_URL, OC_MM_TOKEN and OC_MM_TEAM, or url/token/team plugin options",
    );
    return {};
  }

  const client = createMattermostClient({ url, token });
  const downloadDir = await resolveDownloadDir(strOption(options, "downloadDir"), input);
  const ctx = createMattermostContext({ url, token, team }, client, { downloadDir });
  try {
    // Probe the server once at load; registering tools we cannot serve would turn every
    // later tool call into an error. `me()` goes first because it is the call that proves the
    // token — running it alongside `team()` let the team lookup's "team not found" win the race
    // and report a bad token as a bad team.
    await withTimeout(
      (async () => {
        await ctx.me();
        await ctx.team();
      })(),
      STARTUP_TIMEOUT_MS,
      `${url} did not respond within ${STARTUP_TIMEOUT_MS}ms`,
    );
  } catch (error) {
    // Restate it the way every tool call does: a `ClientError` carries the server's sentence and
    // nothing else, and that sentence is empty when the body is not Mattermost's JSON envelope —
    // which printed a bare "oc-mm-client disabled:" with no reason at all.
    const described = describeClientError(error);
    await log(
      input,
      "error",
      `oc-mm-client disabled: ${described instanceof Error ? described.message : String(described)}`,
    );
    return {};
  }

  return { tool: createTools(ctx) };
}) satisfies Plugin;
