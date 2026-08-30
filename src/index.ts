import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMattermostClient } from "./mattermost/client.js";
import { createMattermostContext, withTimeout } from "./mattermost/context.js";
import { loadEnvFile, type MattermostEnv, mergeEnv, readMattermostEnv } from "./mattermost/env.js";
import { createTools, describeClientError } from "./mattermost/tools/registry.js";

const STARTUP_TIMEOUT_MS = 10_000;

function strOption(options: PluginOptions | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Two channels, in this order. opencode's own log first: it captures nothing a plugin writes to
 * stdout or stderr, and in the TUI that text is painted into the frame the interface is about to
 * repaint — a flicker at startup, torn output later — while reaching no log file at all. Sent to
 * `/log` it lands where `--print-logs` and `log/opencode.log` look, and since the service name is
 * not rendered in the line, the message keeps carrying the plugin's name itself. `console.error` is
 * kept for the case where that endpoint does not take the message — the generated client `await`s a
 * bare fetch, so an unreachable server rejects, and a 400 comes back as `{ error }` instead of
 * throwing. A torn line in the TUI still says why the plugin went quiet; nothing at all does not.
 * Never rejects: every caller is on a path that must still return `{}`, and a failure to report the
 * diagnosis must not replace it.
 */
async function log(input: PluginInput, level: "warn" | "error", message: string) {
  try {
    const { error } = await input.client.app.log({
      body: { service: "oc-mm-client", level, message },
    });
    if (!error) return;
  } catch {
    // A rejected transport means the message never arrived either; fall through to stderr.
  }
  console.error(message);
}

/**
 * `realpath` of the longest ancestor that exists, with the segments below it appended back. The
 * download directory is created on the first download, so at load time it usually does not exist yet
 * and a plain `realpath` could only answer ENOENT — while the parent it will be created under may
 * well be a link that leads out of the worktree. A path that resolves nowhere at all (an ancestor
 * that denies traversal, say) is handed back untouched, which leaves the containment check lexical
 * for that one path instead of failing the plugin over it.
 */
async function followLinks(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * The option is a path relative to the project directory — resolved there rather than against the
 * process cwd for the same reason `.env.local` is, one comment below. Four values are refused, all
 * of them the same way, because a configuration mistake, unlike a missing credential, leaves the
 * plugin perfectly able to work: anything that lands outside the worktree, since opencode resolves
 * the agent's `read` permission against it and a file saved elsewhere is one the caller cannot open
 * afterwards; the worktree root itself, where attachments would be strewn among the tracked sources;
 * anything under `.git`, where dropping files is a good deal worse than untidy; and a non-string,
 * which would otherwise be the one mistake that produces no message at all. The comparison runs on
 * `realpath`ed paths — both sides, so a worktree that itself sits under a link still matches — since
 * a lexical `relative()` reads `<worktree>/attachments` as contained however far out the link points.
 */
async function resolveDownloadDir(value: unknown, input: PluginInput): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const ignore = (subject: string, reason: string) =>
    log(
      input,
      "warn",
      `oc-mm-client: ignoring downloadDir ${subject} — ${reason}; using the default .opencode/mm-files`,
    );
  if (typeof value !== "string" || !value.trim()) {
    // Quoted, because the point of the message is the shape of the value: an unquoted `["a"]` or a
    // whitespace-only string looks in the log exactly like the path the user meant to write.
    await ignore(
      JSON.stringify(value),
      typeof value === "string" ? "it is blank" : "it is not a string path",
    );
    return undefined;
  }
  const dir = value.trim();
  const resolved = resolve(input.directory, dir);
  // The worktree, not the session directory: `read` permissions are resolved against it, and it is
  // the wider of the two when opencode is started inside a subdirectory.
  const root = await followLinks(input.worktree);
  const real = await followLinks(resolved);
  const rel = relative(root, real);
  if (!rel) {
    await ignore(dir, `it is ${root} itself, where attachments would litter the tracked sources`);
    return undefined;
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    await ignore(dir, `it resolves to ${real}, outside ${root}`);
    return undefined;
  }
  if (rel.split(sep).includes(".git")) {
    await ignore(dir, `it resolves to ${real}, inside a git directory`);
    return undefined;
  }
  // The configured path, not its `realpath`: a link inside the worktree is one the caller can read
  // through, and the description reads better naming the directory that was actually asked for.
  return resolved;
}

export default (async (input, options) => {
  // Anchored to the project directory, not the process cwd: `opencode run --dir=<project>` leaves
  // the cwd wherever it was launched, and a relative path would miss the project's `.env.local`.
  const fileEnv = loadEnvFile(join(input.directory, ".env.local"));
  let env: MattermostEnv | undefined;
  try {
    env = readMattermostEnv(mergeEnv(fileEnv));
  } catch {
    // Incomplete env is not fatal here: plugin options can supply what is missing.
    env = undefined;
  }
  const url = strOption(options, "url") ?? env?.url;
  const token = strOption(options, "token") ?? env?.token;
  const team = strOption(options, "team") ?? env?.team;
  // Ahead of the credentials gate, whose early return would otherwise hide this mistake behind that
  // one and cost a second restart to learn about it. Nothing is paid for the reordering: the check
  // reads the filesystem and never the network.
  const downloadDir = await resolveDownloadDir(options?.downloadDir, input);
  if (!url || !token || !team) {
    // Only what is still missing once options and environment are combined: telling someone whose
    // url and token are fine to "set OC_MM_URL, OC_MM_TOKEN and OC_MM_TEAM" sends them auditing two
    // settings that were already right. Both sources are named because either one satisfies it.
    const missing = [url ? null : "url", token ? null : "token", team ? null : "team"].filter(
      (name) => name !== null,
    );
    await log(
      input,
      "error",
      `oc-mm-client disabled: set ${missing
        .map((name) => `OC_MM_${name.toUpperCase()}`)
        .join(", ")} — or the ${missing.join(", ")} plugin option${missing.length > 1 ? "s" : ""}`,
    );
    return {};
  }

  const client = createMattermostClient({ url, token });
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
