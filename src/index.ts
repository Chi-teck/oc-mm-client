import { access, constants, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMattermostClient } from "./mattermost/client.js";
import { createMattermostContext, withTimeout } from "./mattermost/context.js";
import { loadEnvFile, type MattermostEnv, mergeEnv, readMattermostEnv } from "./mattermost/env.js";
import { createTools, describeClientError } from "./mattermost/tools/registry.js";
import { contains } from "./paths.js";

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
 * diagnosis must not replace it. Always an error, since every line the plugin has to say is one
 * about a plugin that is not going to run.
 */
async function log(input: PluginInput, message: string) {
  try {
    const { error } = await input.client.app.log({
      body: { service: "oc-mm-client", level: "error", message },
    });
    if (!error) return;
  } catch {
    // A rejected transport means the message never arrived either; fall through to stderr.
  }
  console.error(message);
}

/**
 * Where the option may not point, and why: outside the worktree, since opencode resolves the agent's
 * `read` permission against it and a file saved elsewhere is one the caller cannot open afterwards;
 * the worktree root itself, where attachments would be strewn among the tracked sources; and
 * anything under `.git`, where dropping files is a good deal worse than untidy. Run twice by the
 * caller — once on the path as written, so a directory that was never going to be allowed is named
 * as such rather than as one that happens not to exist, and once on the `realpath`s, since a lexical
 * `relative()` reads `<worktree>/attachments` as contained however far out a link points.
 */
function containment(root: string, candidate: string): string | undefined {
  const where = contains(root, candidate);
  if (where === "root") {
    return `is ${root} itself, where attachments would litter the tracked sources`;
  }
  if (where === "outside") return `resolves to ${candidate}, outside ${root}`;
  if (relative(root, candidate).split(sep).includes(".git")) {
    return `resolves to ${candidate}, inside a git directory`;
  }
  return undefined;
}

/**
 * The errno of a `stat` that failed, in the words of whoever has to fix the line in `opencode.json`:
 * ENOTDIR is a component of the path that is a file, ENOENT the path itself, and the distinction
 * between them is not worth a sentence.
 */
function statReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "does not exist";
  if (code === "ENOTDIR") return "is not a directory";
  return `cannot be read (${code ?? String(error)})`;
}

/**
 * The option is a path relative to the project directory — resolved there rather than against the
 * process cwd for the same reason `.env.local` is, one comment below — and it is required: there is
 * no implicit default, so a plugin that cannot agree with its user on where downloads land does not
 * start. Every way of getting it wrong is fatal, and none of them is created away. A directory that
 * is absent, is a file, or cannot be written is one that every `mattermost_get_file` call would fail
 * on, so registering the tool would only move the discovery to the first attachment somebody needed;
 * and `mkdir` here would turn a typo into a second empty directory nobody asked for, sitting next to
 * the one that was meant. A non-string is refused with the rest, since it would otherwise be the one
 * mistake that produces no message at all.
 */
async function resolveDownloadDir(
  value: unknown,
  input: PluginInput,
): Promise<{ path?: string; error?: string }> {
  const refuse = (subject: string, reason: string) => ({
    error: `downloadDir ${subject} ${reason}`,
  });
  if (value === undefined) return { error: "set the downloadDir plugin option" };
  if (typeof value !== "string" || !value.trim()) {
    // Quoted, because the point of the message is the shape of the value: an unquoted `["a"]` or a
    // whitespace-only string looks in the log exactly like the path the user meant to write.
    return refuse(
      JSON.stringify(value),
      typeof value === "string" ? "is blank" : "is not a string path",
    );
  }
  const dir = value.trim();
  const resolved = resolve(input.directory, dir);
  // The worktree, not the session directory: `read` permissions are resolved against it, and it is
  // the wider of the two when opencode is started inside a subdirectory.
  const lexical = containment(input.worktree, resolved);
  if (lexical) return refuse(dir, lexical);
  let real: string;
  try {
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return refuse(dir, `resolves to ${resolved}, which is not a directory`);
    }
    // Cannot fail once `stat` has walked the same path, but it is the call that reports where a
    // link actually leads, and the containment check below is only as good as it.
    real = await realpath(resolved);
  } catch (error) {
    return refuse(dir, `resolves to ${resolved}, which ${statReason(error)}`);
  }
  // Both sides resolved, so a worktree that itself sits under a link still matches.
  const escaped = containment(await realpath(input.worktree).catch(() => input.worktree), real);
  if (escaped) return refuse(dir, escaped);
  try {
    await access(real, constants.W_OK);
  } catch {
    return refuse(dir, `resolves to ${real}, which is not writable`);
  }
  // The configured path, not its `realpath`: a link inside the worktree is one the caller can read
  // through, and the description reads better naming the directory that was actually asked for.
  return { path: resolved };
}

/**
 * `uploadRoot` is the other direction: every `mattermost_create_post` attachment has to resolve
 * inside it. Unlike `downloadDir` it is optional — the worktree is a sane default, and requiring it
 * would break every existing config to state what the default already says — so an absent value is
 * neither a path nor an error. Checked here rather than per call for the same reason as the other:
 * a root that cannot work is one every attachment would fail on, and finding that out at startup
 * beats finding it out on the first file somebody needed.
 *
 * A shorter list than `resolveDownloadDir`'s, because the two directories are not the same kind of
 * thing. Nothing is ever written here, so writability is not asked for; and the whole point of the
 * option having a value is to name a boundary other than the default, including one outside the
 * worktree — `"/"` is the documented way to keep the pre-v0.4.0 behaviour — so containment is not
 * asked for either. What is left is that the path exists and is a directory: a root that is neither
 * refuses every attachment, silently, in a message about the file rather than about the config.
 */
async function resolveUploadRoot(
  value: unknown,
  input: PluginInput,
): Promise<{ path?: string; error?: string }> {
  const refuse = (subject: string, reason: string) => ({
    error: `uploadRoot ${subject} ${reason}`,
  });
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.trim()) {
    return refuse(
      JSON.stringify(value),
      typeof value === "string" ? "is blank" : "is not a string path",
    );
  }
  const dir = value.trim();
  // The project directory, not the process cwd, for the reason `downloadDir` and `.env.local` are.
  const resolved = resolve(input.directory, dir);
  try {
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return refuse(dir, `resolves to ${resolved}, which is not a directory`);
    }
  } catch (error) {
    return refuse(dir, `resolves to ${resolved}, which ${statReason(error)}`);
  }
  // Not the `realpath`: the containment check resolves both sides at call time, so a root reached
  // through a link still matches the files under it, and the configured path is the one to report.
  return { path: resolved };
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
  const { path: downloadDir, error: downloadError } = await resolveDownloadDir(
    options?.downloadDir,
    input,
  );
  const { path: uploadRoot, error: uploadError } = await resolveUploadRoot(
    options?.uploadRoot,
    input,
  );
  // Only what is still missing once options and environment are combined: telling someone whose url
  // and token are fine to "set OC_MM_URL, OC_MM_TOKEN and OC_MM_TEAM" sends them auditing two
  // settings that were already right. Both sources are named because either one satisfies it.
  const missing = [url ? null : "url", token ? null : "token", team ? null : "team"].filter(
    (name) => name !== null,
  );
  // Both gates in one line. Either is fatal on its own, and reporting whichever was checked first
  // would leave the other to be discovered on the next restart, and the one after that.
  const problems: string[] = [];
  if (missing.length) {
    problems.push(
      `set ${missing
        .map((name) => `OC_MM_${name.toUpperCase()}`)
        .join(", ")} — or the ${missing.join(", ")} plugin option${missing.length > 1 ? "s" : ""}`,
    );
  }
  if (downloadError) problems.push(downloadError);
  if (uploadError) problems.push(uploadError);
  // `uploadRoot` is tested through its error, not its absence: unset is the default, not a mistake.
  if (!url || !token || !team || !downloadDir || uploadError) {
    await log(input, `oc-mm-client disabled: ${problems.join("; ")}`);
    return {};
  }

  const client = createMattermostClient({ url, token });
  const ctx = createMattermostContext({ url, token, team }, client, { downloadDir, uploadRoot });
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
      `oc-mm-client disabled: ${described instanceof Error ? described.message : String(described)}`,
    );
    return {};
  }

  return { tool: createTools(ctx) };
}) satisfies Plugin;
