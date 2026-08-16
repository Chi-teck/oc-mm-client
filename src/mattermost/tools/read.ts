import { ClientError } from "@mattermost/client";
import type { Post, PostList } from "@mattermost/types/posts";
import { tool } from "@opencode-ai/plugin";
import type { MattermostContext } from "../context.js";

// `last_viewed_at === 0` means the channel was never opened, so its whole history reads as unread.
const FIRST_RUN_NOTE = "first run: full history unread, consider mark_read bootstrap";
const DEFAULT_LIMIT = 30;

export function readPostsTool(ctx: MattermostContext) {
  return tool({
    description:
      'Read posts from a Mattermost channel. Branches: thread_root_id → full thread; pinned → pinned posts; before → posts older than a post id; since → posts since a time ("2h", "30m", ISO date, epoch ms); otherwise latest posts (limit, default 30). Bodies are cut at 500 chars unless full=true.',
    args: {
      channel: tool.schema.string().describe("Channel name or 26-char id"),
      since: tool.schema
        .string()
        .optional()
        .describe('Posts since this time: "2h", "30m", "45s", "3d", ISO date, or epoch ms'),
      before: tool.schema
        .string()
        .optional()
        .describe("Read the posts older than this post id (page backwards)"),
      thread_root_id: tool.schema
        .string()
        .optional()
        .describe("Read the full thread of this root post id"),
      pinned: tool.schema.boolean().optional().describe("Read only pinned posts"),
      limit: tool.schema
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max posts to fetch and show (default 30, max 200)"),
      full: tool.schema
        .boolean()
        .optional()
        .describe("Print message bodies in full instead of cutting them at 500 chars"),
    },
    execute: async ({ channel, since, before, thread_root_id: rootId, pinned, limit, full }) => {
      const resolved = await ctx.resolveChannel(channel);
      const max = limit ?? DEFAULT_LIMIT;
      let list: PostList;
      let scope: string;
      if (rootId) {
        list = await ctx.client.getPostThread(rootId);
        scope = `thread ${rootId}`;
      } else if (pinned) {
        list = await ctx.client.getPinnedPosts(resolved.id);
        scope = "pinned";
      } else if (before !== undefined) {
        list = await ctx.client.getPostsBefore(resolved.id, before, 0, max);
        scope = `before ${before}`;
      } else if (since !== undefined) {
        list = await ctx.client.getPostsSince(resolved.id, ctx.parseSince(since));
        scope = `since ${since}`;
      } else {
        list = await ctx.client.getPosts(resolved.id, 0, max);
        scope = "latest";
      }
      const output = await ctx.formatPosts(list, { limit: max, full });
      return { title: `Mattermost: ${resolved.name} (${scope})`, output };
    },
  });
}

export function getPostTool(ctx: MattermostContext) {
  return tool({
    description:
      "Read one Mattermost post by id — its channel, author, body, reactions and attachments. Use it to check a single post (one just written, one named in a search hit) instead of reading the channel and filtering.",
    args: {
      post_id: tool.schema.string().describe("26-char post id"),
      full: tool.schema
        .boolean()
        .optional()
        .describe("Print the message body in full instead of cutting it at 500 chars"),
    },
    execute: async ({ post_id: postId, full }) => {
      let post: Post;
      try {
        post = await ctx.client.getPost(postId);
      } catch (error) {
        // A deleted post and a post in an unreadable channel both answer 404, and the server's
        // own message ("Unable to get the post.") distinguishes neither.
        if (!(error instanceof ClientError) || error.status_code !== 404) throw error;
        throw new Error(
          `Post ${postId} not found — it is deleted, or in a channel this user cannot read.`,
        );
      }
      const name = await ctx
        .resolveChannel(post.channel_id)
        .then((channel) => channel.name)
        .catch(() => post.channel_id);
      const list: PostList = {
        order: [post.id],
        posts: { [post.id]: post },
        next_post_id: "",
        prev_post_id: "",
        first_inaccessible_post_time: 0,
      };
      const body = await ctx.formatPosts(list, { limit: 1, full });
      return { title: `Mattermost: post in ${name}`, output: `in ${name}:\n${body}` };
    },
  });
}

export function readUnreadTool(ctx: MattermostContext) {
  return tool({
    description:
      "Show unread message and mention counts per channel; with a channel arg, show the unread posts in that channel.",
    args: {
      channel: tool.schema.string().optional().describe("Channel name or 26-char id"),
      limit: tool.schema
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max posts to show (default 30, max 200)"),
      full: tool.schema
        .boolean()
        .optional()
        .describe("Print message bodies in full instead of cutting them at 500 chars"),
    },
    execute: async ({ channel, limit, full }) => {
      if (channel === undefined) {
        const team = await ctx.team();
        const [memberships, channels] = await Promise.all([
          ctx.client.getMyChannelMembers(team.id),
          ctx.client.getMyChannels(team.id),
        ]);
        const byId = new Map(channels.map((c) => [c.id, c]));
        const lines: string[] = [];
        let firstRun = false;
        for (const membership of memberships) {
          const ch = byId.get(membership.channel_id);
          if (!ch) continue;
          // Mattermost reports no unread count: it is the channel total minus what this member read.
          const unread = ch.total_msg_count - membership.msg_count;
          const mentions = membership.mention_count;
          if (unread <= 0 && mentions <= 0) continue;
          if (membership.last_viewed_at === 0) firstRun = true;
          const dm = ch.type === "D" ? " [DM]" : "";
          const plural = mentions === 1 ? "" : "s";
          lines.push(`${ch.name}: ${unread} unread, ${mentions} mention${plural}${dm}`);
        }
        const parts = [lines.length ? lines.join("\n") : "No unread messages."];
        if (firstRun) parts.push(FIRST_RUN_NOTE);
        return { title: "Mattermost: unread overview", output: parts.join("\n") };
      }
      const resolved = await ctx.resolveChannel(channel);
      const [totals, membership] = await Promise.all([
        ctx.client.getChannel(resolved.id),
        ctx.client.getChannelMember(resolved.id, "me"),
      ]);
      const unread = totals.total_msg_count - membership.msg_count;
      if (unread <= 0) {
        return {
          title: `Mattermost: unread in ${resolved.name}`,
          output: `No unread messages in ${resolved.name}.`,
        };
      }
      const me = await ctx.me();
      const list = await ctx.client.getPostsUnread(resolved.id, me.id);
      const note = membership.last_viewed_at === 0 ? `\n${FIRST_RUN_NOTE}` : "";
      const body = await ctx.formatPosts(list, { limit, full });
      return {
        title: `Mattermost: unread in ${resolved.name}`,
        output: `${resolved.name}: ${unread} unread (context included)\n${body}${note}`,
      };
    },
  });
}
