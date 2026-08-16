import type { FileSearchResultItem } from "@mattermost/types/files";
import type { Post } from "@mattermost/types/posts";
import type { UserProfile } from "@mattermost/types/users";
import { tool } from "@opencode-ai/plugin";
import { humanSize, type MattermostContext, relTime, truncate } from "../context.js";
import { confirmWrite } from "./confirm.js";

const MAX_HITS = 30;
const PROFILE_PAGE = 200;
const MAX_PROFILES = 1000;
const SEARCH_HINT = "read it with mattermost_read_posts full=true";

function displayName(profile: UserProfile): string {
  const full = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  return full ? `- ${profile.username} — ${full}` : `- ${profile.username}`;
}

async function channelNames(
  ctx: MattermostContext,
  channelIds: string[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    [...new Set(channelIds)].map(
      async (id) =>
        [
          id,
          await ctx
            .resolveChannel(id)
            .then((c) => c.name)
            .catch(() => id),
        ] as const,
    ),
  );
  return new Map(entries);
}

async function channelProfiles(
  ctx: MattermostContext,
  channelId: string,
): Promise<{ profiles: UserProfile[]; complete: boolean }> {
  const profiles: UserProfile[] = [];
  for (let page = 0; profiles.length < MAX_PROFILES; page++) {
    const batch = await ctx.client.getProfilesInChannel(channelId, page, PROFILE_PAGE);
    profiles.push(...batch);
    if (batch.length < PROFILE_PAGE) return { profiles, complete: true };
  }
  return { profiles, complete: false };
}

export function editPostTool(ctx: MattermostContext) {
  return tool({
    description: "Edit or delete one of the bot's own Mattermost posts.",
    args: {
      post_id: tool.schema.string().describe("Post id"),
      action: tool.schema.enum(["edit", "delete"]).describe("Edit (needs message) or delete"),
      message: tool.schema.string().optional().describe("New message text (required for edit)"),
    },
    execute: async ({ post_id: postId, action, message }, tctx) => {
      await confirmWrite(tctx, "mattermost_edit_post", `mattermost_edit_post ${action} ${postId}`);
      if (action === "edit") {
        if (message === undefined) throw new Error("edit requires a message");
        await ctx.client.patchPost({ id: postId, message });
        return { title: "Mattermost: edited post", output: `Edited post ${postId}` };
      }
      await ctx.client.deletePost(postId);
      return { title: "Mattermost: deleted post", output: `Deleted post ${postId}` };
    },
  });
}

export function searchTool(ctx: MattermostContext) {
  return tool({
    description:
      'Search Mattermost posts or files across the team by keyword (type: "posts" or "files").',
    args: {
      query: tool.schema.string().describe("Search terms"),
      type: tool.schema.enum(["posts", "files"]).describe("Search posts or files"),
    },
    execute: async ({ query, type }) => {
      const team = await ctx.team();
      if (type === "files") {
        const results = await ctx.client.searchFiles(team.id, query, false);
        // @mattermost/types declares file_infos as a Map; the JSON is a plain object keyed by id.
        const infos = results.file_infos as unknown as Record<string, FileSearchResultItem>;
        const hits = results.order
          .map((id) => infos[id])
          .filter((info): info is FileSearchResultItem => Boolean(info))
          .slice(0, MAX_HITS);
        const names = await channelNames(
          ctx,
          hits.map((info) => info.channel_id),
        );
        const lines = hits.map(
          (info) =>
            `  [file] ${info.name} (${info.mime_type}, ${humanSize(info.size)}, id: ${info.id}) [${names.get(info.channel_id) ?? info.channel_id}]`,
        );
        return {
          title: `Mattermost: file search "${query}"`,
          output: lines.length ? lines.join("\n") : `No files found for "${query}".`,
        };
      }
      const results = await ctx.client.searchPosts(team.id, query, false);
      const posts = results.order
        .map((id) => results.posts[id])
        .filter((p): p is Post => Boolean(p))
        .sort((a, b) => b.create_at - a.create_at)
        .slice(0, MAX_HITS);
      const [usernames, names] = await Promise.all([
        ctx.usernames(posts.map((post) => post.user_id)).catch(() => new Map<string, string>()),
        channelNames(
          ctx,
          posts.map((post) => post.channel_id),
        ),
      ]);
      const lines = posts.map((post) => {
        const who = usernames.get(post.user_id) ?? post.user_id;
        const channel = names.get(post.channel_id) ?? post.channel_id;
        const body = truncate(post.message, SEARCH_HINT);
        return `**${who}** (${relTime(post.create_at)}) in ${channel}: ${body} (post ${post.id})`;
      });
      return {
        title: `Mattermost: post search "${query}"`,
        output: lines.length ? lines.join("\n") : `No posts found for "${query}".`,
      };
    },
  });
}

export function listMembersTool(ctx: MattermostContext) {
  return tool({
    description:
      "List members of a Mattermost channel; with query, fuzzy-match usernames (out-of-channel matches are marked).",
    args: {
      channel: tool.schema.string().describe("Channel name or 26-char id"),
      query: tool.schema.string().optional().describe("Fuzzy username/name filter"),
    },
    execute: async ({ channel, query }) => {
      const resolved = await ctx.resolveChannel(channel);
      if (query === undefined) {
        const { profiles, complete } = await channelProfiles(ctx, resolved.id);
        const lines = profiles.map(displayName);
        if (!complete) lines.push(`(first ${profiles.length} members — pass query to search)`);
        const count = complete ? `${profiles.length}` : `first ${profiles.length}`;
        return {
          title: `Mattermost: ${count} members of ${resolved.name}`,
          output: lines.join("\n") || "No members found.",
        };
      }
      const team = await ctx.team();
      const match = await ctx.client.autocompleteUsers(query, team.id, resolved.id);
      const inChannel = match.users.map((u) => displayName(u));
      const outOfChannel = (match.out_of_channel ?? []).map(
        (u) => `${displayName(u)} [NOT in channel — mentions won't notify]`,
      );
      const parts = [];
      if (inChannel.length) parts.push(inChannel.join("\n"));
      if (outOfChannel.length) parts.push(outOfChannel.join("\n"));
      return {
        title: `Mattermost: members of ${resolved.name} matching "${query}"`,
        output: parts.length ? parts.join("\n") : `No users matching "${query}".`,
      };
    },
  });
}

export function dmTool(ctx: MattermostContext) {
  return tool({
    description:
      "Open (or reuse) a direct-message channel with a user by username and return its channel name.",
    args: {
      username: tool.schema.string().describe("Username without @"),
    },
    execute: async ({ username }, tctx) => {
      await confirmWrite(tctx, "mattermost_dm", `mattermost_dm @${username}`);
      const user = await ctx.client.getUserByUsername(username);
      const me = await ctx.me();
      const dm = await ctx.client.createDirectChannel([me.id, user.id]);
      return {
        title: `Mattermost: DM channel with @${username}`,
        output: `DM channel with @${username}: ${dm.name} (id: ${dm.id}) — pass it as the channel to mattermost_create_post`,
      };
    },
  });
}
