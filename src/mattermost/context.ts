import type { Client4 } from "@mattermost/client";
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
    teamPromise ??= resolve();
    return teamPromise;
    async function resolve(): Promise<Team> {
      const ref = config.team;
      // The ref is already an id and callers only ever read `.id`, so skip the round trip.
      if (ID_SHAPE.test(ref)) return { id: ref } as Team;
      try {
        return await client.getTeamByName(ref);
      } catch {
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

  async function fileInfos(posts: Post[]): Promise<Map<string, FileInfo[]>> {
    const entries = await Promise.all(
      posts
        .filter((post) => post.file_ids?.length)
        .map(
          async (post) =>
            [post.id, await client.getFileInfosForPost(post.id).catch(() => [])] as const,
        ),
    );
    return new Map(entries);
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
    const [names, files] = await Promise.all([
      usernames(shown.map((post) => post.user_id)).catch(() => new Map<string, string>()),
      fileInfos(shown),
    ]);
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
      for (const info of files.get(post.id) ?? []) {
        lines.push(
          `  [file] ${info.name} (${info.mime_type}, ${humanSize(info.size)}, id: ${info.id})`,
        );
      }
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
    me,
    team,
    clientConfig,
    resolveChannel,
    usernames,
    parseSince: (input: string) => parseSince(input),
    formatPosts,
  };
}
