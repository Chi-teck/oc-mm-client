import { type Client4, ClientError } from "@mattermost/client";
import type { ServerChannel } from "@mattermost/types/channels";
import type { ClientConfig } from "@mattermost/types/config";
import type { FileInfo } from "@mattermost/types/files";
import type { Post, PostList } from "@mattermost/types/posts";
import type { Team } from "@mattermost/types/teams";
import type { UserProfile } from "@mattermost/types/users";
import { createMattermostClient, type MattermostConfig } from "./client.js";
import type { MattermostEnv } from "./env.js";

export const ID_SHAPE = /^[a-z0-9]{26}$/;

const CACHE_TTL = 60_000;
/** How far ahead `parseSchedule` will schedule — see the throw there for why there is a ceiling. */
const MAX_SCHEDULE_DAYS = 365;
const MAX_POSTS = 30;
const MAX_BODY = 500;
const FULL_HINT = "pass full=true for the whole message";

export interface FormatOptions {
  limit?: number;
  full?: boolean;
  /** Set false when the calling tool has no `before` argument, so the paging hint would misfire. */
  paging?: boolean;
}

export interface MattermostContext {
  client: Client4;
  config: MattermostEnv;
  /**
   * Absolute path from the `downloadDir` plugin option, which the plugin requires and checks at
   * startup. Unset only under the CLI, which has no options and takes the default in `files.ts`.
   */
  downloadDir?: string;
  /**
   * Absolute path from the `uploadRoot` plugin option: every `mattermost_create_post` attachment has
   * to resolve inside it. Unset means `worktree`, which is where opencode resolves the agent's own
   * `read` permission — so the plugin ends up matching its host rather than exceeding it.
   */
  uploadRoot?: string;
  /** Where a relative attachment path starts: the session directory, or the CLI's cwd. */
  directory: string;
  /**
   * The git worktree root the plugin was started in, or the CLI's cwd. opencode v2 no longer puts
   * either path on the tool call, so both are fixed when the context is built.
   */
  worktree: string;
  me(): Promise<UserProfile>;
  team(): Promise<Team>;
  clientConfig(): Promise<ClientConfig>;
  resolveChannel(ref: string): Promise<ServerChannel>;
  usernames(userIds: string[]): Promise<Map<string, string>>;
  parseSince(input: string): number;
  formatPosts(list: PostList, options?: FormatOptions): Promise<string>;
}

export function parseSince(input: string, now = Date.now()): number {
  const rel = /^(\d+)([smhd])$/.exec(input);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      rel[2] as "s" | "m" | "h" | "d"
    ];
    return now - n * unit;
  }
  if (/^\d+$/.test(input)) return Number(input);
  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) return parsed;
  throw new Error(`Invalid since: ${input} (use "2h", "30m", ISO date, or epoch ms)`);
}

/**
 * `parseSince`'s future-facing sibling: the same grammar, added to `now` instead of subtracted, so
 * the agent writes one time vocabulary across tools. Epoch milliseconds out, which is also what the
 * `scheduled_at` wire field takes. Bounded on both sides, because the unit is the thing a caller
 * gets wrong: seconds land in 1970 and microseconds in the year 59009, and neither is a schedule.
 */
export function parseSchedule(input: string, now = Date.now()): number {
  const rel = /^(\d+)([smhd])$/.exec(input);
  let at: number;
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      rel[2] as "s" | "m" | "h" | "d"
    ];
    at = now + n * unit;
  } else if (/^\d+$/.test(input)) {
    at = Number(input);
  } else {
    at = Date.parse(input);
    if (Number.isNaN(at)) {
      throw new Error(`Invalid schedule_at: ${input} (use "30m", "2h", ISO date, or epoch ms)`);
    }
  }
  // Name both halves: the caller wrote a date, the server would have to send it in the past.
  if (at <= now) {
    throw new Error(`Cannot schedule in the past: ${input} resolved to ${relTime(at, now)}`);
  }
  // A ceiling as well as a floor. Epoch microseconds are a future timestamp by every check above,
  // and they schedule for the year 59009: the post is simply never sent, and nothing else in the
  // tool would notice. Epoch nanoseconds are past what `Date` can even represent, so the resolved
  // value is printed as a bare number here — `toISOString` throws on those, and the prompt that
  // would have shown the caller "Invalid Date" is exactly what this check exists to prevent.
  if (at > now + MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new Error(
      `Cannot schedule more than ${MAX_SCHEDULE_DAYS} days out: ${input} resolved to epoch ms ${at} — a value this far ahead is usually microseconds or nanoseconds mistaken for milliseconds`,
    );
  }
  return at;
}

export function relTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** `:thumbsup: 2 :eyes: 1`, or "" when nobody reacted. */
export function reactionSummary(post: Post): string {
  const counts = new Map<string, number>();
  for (const reaction of post.metadata?.reactions ?? []) {
    counts.set(reaction.emoji_name, (counts.get(reaction.emoji_name) ?? 0) + 1);
  }
  return [...counts].map(([emoji, count]) => `:${emoji}: ${count}`).join(" ");
}

export function truncate(body: string, hint: string, max = MAX_BODY): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n**[truncated at ${max} chars — ${hint}]**`;
}

/**
 * Unread posts for one member. Mattermost reports no unread count: it is the channel total minus
 * what the member has read. Clamped, because a retention purge, a channel type conversion or CRT
 * root-count skew can leave `read` above `total`, and a negative unread count is nonsense.
 */
export function unreadCount(total: number, read: number): number {
  return Math.max(0, total - read);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export function createMattermostContext(
  config: MattermostEnv,
  client: Client4 = createMattermostClient(config satisfies MattermostConfig),
  options: {
    downloadDir?: string;
    uploadRoot?: string;
    directory?: string;
    worktree?: string;
  } = {},
): MattermostContext {
  let mePromise: Promise<UserProfile> | undefined;
  let teamPromise: Promise<Team> | undefined;

  const channelCache = new Map<string, { channel: ServerChannel; expires: number }>();
  const userCache = new Map<string, { username: string; expires: number }>();
  let serverConfig: { value: ClientConfig; expires: number } | undefined;

  function me(): Promise<UserProfile> {
    // Cache the promise so concurrent callers share one request, but drop it on failure so a
    // transient error is not cached for the life of the process.
    mePromise ??= client.getMe().catch((error: unknown) => {
      mePromise = undefined;
      throw error;
    });
    return mePromise;
  }

  function team(): Promise<Team> {
    // Same promise cache as `me()`, including the reset: a transient failure must not be cached.
    teamPromise ??= resolve().catch((error: unknown) => {
      teamPromise = undefined;
      throw error;
    });
    return teamPromise;
    async function resolve(): Promise<Team> {
      const ref = config.team;
      // The ref is already an id and callers only ever read `.id`, so skip the round trip.
      if (ID_SHAPE.test(ref)) return { id: ref } as Team;
      try {
        return await client.getTeamByName(ref);
      } catch (error) {
        // Only a 404 means the name is wrong. A 401, a 500 or a connection failure that never
        // became a `ClientError` is the token, the server or the network — relabelling those as a
        // missing team sends the reader to a config file that is fine.
        if (!(error instanceof ClientError) || error.status_code !== 404) throw error;
        throw new Error(`Mattermost team not found: ${ref}`);
      }
    }
  }

  async function clientConfig(): Promise<ClientConfig> {
    const now = Date.now();
    if (serverConfig && serverConfig.expires > now) return serverConfig.value;
    const value = await client.getClientConfig();
    serverConfig = { value, expires: now + CACHE_TTL };
    return value;
  }

  async function lookupChannel(ref: string): Promise<ServerChannel> {
    if (ID_SHAPE.test(ref)) {
      try {
        return await client.getChannel(ref);
      } catch {
        throw new Error(`Channel not found: ${ref}`);
      }
    }
    const { id: teamId } = await team();
    try {
      return await client.getChannelByName(teamId, ref);
    } catch {
      const channels = await client.getMyChannels(teamId);
      const lower = ref.toLowerCase();
      const near = channels.filter(
        (channel) =>
          channel.name.toLowerCase().includes(lower) ||
          channel.display_name.toLowerCase().includes(lower),
      );
      const hint = near.length
        ? ` Did you mean: ${near.map((channel) => channel.name).join(", ")}?`
        : "";
      throw new Error(`Channel not found: ${ref}.${hint}`);
    }
  }

  async function resolveChannel(ref: string): Promise<ServerChannel> {
    const cached = channelCache.get(ref);
    if (cached && cached.expires > Date.now()) return cached.channel;
    const channel = await lookupChannel(ref);
    const entry = { channel, expires: Date.now() + CACHE_TTL };
    // Keyed by both so a later lookup by name or by id hits the same entry.
    channelCache.set(ref, entry);
    channelCache.set(channel.id, entry);
    return channel;
  }

  async function usernames(userIds: string[]): Promise<Map<string, string>> {
    const now = Date.now();
    const known = new Map<string, string>();
    const missing: string[] = [];
    for (const id of new Set(userIds)) {
      const cached = userCache.get(id);
      if (cached && cached.expires > now) known.set(id, cached.username);
      else missing.push(id);
    }
    if (!missing.length) return known;
    for (const profile of await client.getProfilesByIds(missing)) {
      userCache.set(profile.id, { username: profile.username, expires: now + CACHE_TTL });
      known.set(profile.id, profile.username);
    }
    return known;
  }

  /** Attachments straight from the post metadata the server already sent — no extra requests. */
  function fileInfos(posts: Post[]): Map<string, FileInfo[]> {
    return new Map(posts.map((post) => [post.id, post.metadata?.files ?? []]));
  }

  async function formatPosts(list: PostList, options: FormatOptions = {}): Promise<string> {
    const limit = Math.max(1, options.limit ?? MAX_POSTS);
    const all = list.order
      .map((id) => list.posts[id])
      .filter((post): post is Post => Boolean(post))
      // A `since` read carries tombstones for posts deleted inside the window: `delete_at` is set
      // and the body is blanked. They are there to invalidate a client cache, not to be read.
      .filter((post) => !post.delete_at && post.state !== "DELETED")
      .sort((a, b) => a.create_at - b.create_at);
    if (!all.length) return "(no posts)";
    const shown = all.length > limit ? all.slice(all.length - limit) : all;
    const names = await usernames(shown.map((post) => post.user_id)).catch(
      () => new Map<string, string>(),
    );
    const files = fileInfos(shown);
    const lines: string[] = [];
    for (const post of shown) {
      const who = names.get(post.user_id) ?? post.user_id;
      const when = relTime(post.create_at);
      const body = options.full ? post.message : truncate(post.message, FULL_HINT);
      if (post.root_id) {
        lines.push(`  ↳ **${who}** (${when}): ${body} (thread ${post.root_id})`);
      } else {
        lines.push(`**${who}** (${when}): ${body}`);
      }
      const infos = files.get(post.id) ?? [];
      for (const info of infos) {
        lines.push(
          `  [file] ${info.name} (${info.mime_type}, ${humanSize(info.size)}, id: ${info.id})`,
        );
      }
      // The server can withhold metadata for an attachment it still lists in `file_ids`. Say so
      // rather than rendering the post as if it had none. Measured against 11.0.4: only deleted
      // posts do this, and the filter above has already dropped those.
      const missing = (post.file_ids?.length ?? 0) - infos.length;
      if (missing > 0) lines.push(`  [file] (${missing} unavailable — server sent no metadata)`);
      const reactions = reactionSummary(post);
      if (reactions) lines.push(`  [reactions] ${reactions}`);
    }
    const oldest = shown[0];
    // `prev_post_id` is the server's own "older posts exist" flag: set when the page it returned
    // is not the start of the channel, empty when it is. The length check covers the branches
    // that fetch without a limit (`pinned`, `since`, unread) and get trimmed for display here.
    if (oldest && options.paging !== false && (all.length > shown.length || list.prev_post_id)) {
      lines.push(`(${shown.length} posts shown — older posts exist, pass before=${oldest.id})`);
    }
    return lines.join("\n");
  }

  return {
    client,
    config,
    downloadDir: options.downloadDir,
    uploadRoot: options.uploadRoot,
    directory: options.directory ?? process.cwd(),
    worktree: options.worktree ?? process.cwd(),
    me,
    team,
    clientConfig,
    resolveChannel,
    usernames,
    parseSince: (input: string) => parseSince(input),
    formatPosts,
  };
}
