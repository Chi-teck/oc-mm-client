import { ClientError } from "@mattermost/client";
import type { Post, PostList } from "@mattermost/types/posts";
import { z } from "zod";
import { type MattermostContext, unreadCount } from "../context.js";
import { tool } from "./types.js";

// `last_viewed_at === 0` means the channel was never opened, so its whole history reads as unread.
const FIRST_RUN_NOTE = "first run: full history unread, consider mark_read bootstrap";
const DEFAULT_LIMIT = 30;
// Already-read posts fetched below the unread ones so the first unread one has some context.
const CONTEXT_LIMIT = 5;

export function readPostsTool(ctx: MattermostContext) {
  return tool({
    description:
      'Read posts from a Mattermost channel. Branches: thread_root_id → a thread\'s root plus its newest replies; pinned → pinned posts; before → posts older than a post id; since → posts since a time ("2h", "30m", ISO date, epoch ms); otherwise latest posts (limit, default 30). Bodies are cut at 500 chars unless full=true.',
    input: z.object({
      channel: z.string().describe("Channel name or 26-char id"),
      since: z
        .string()
        .optional()
        .describe('Posts since this time: "2h", "30m", "45s", "3d", ISO date, or epoch ms'),
      before: z
        .string()
        .optional()
        .describe("Read the posts older than this post id (page backwards)"),
      thread_root_id: z
        .string()
        .optional()
        .describe("Read this thread: its root post plus the newest replies (up to limit)"),
      pinned: z.boolean().optional().describe("Read only pinned posts"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Max posts to fetch and show (default 30, max 200); on a thread it counts replies and the root is shown on top of them",
        ),
      full: z
        .boolean()
        .optional()
        .describe("Print message bodies in full instead of cutting them at 500 chars"),
    }),
    execute: async ({ channel, since, before, thread_root_id: rootId, pinned, limit, full }) => {
      const resolved = await ctx.resolveChannel(channel);
      const max = limit ?? DEFAULT_LIMIT;
      let list: PostList;
      let scope: string;
      let note = "";
      if (rootId) {
        // `direction: "up"` pages from the newest reply; the default "down" pages from the oldest,
        // so a long thread came back without its conclusion. `perPage` counts replies — the root
        // is always returned on top of them.
        const thread = await ctx.client.getPaginatedPostThread(rootId, {
          perPage: max,
          direction: "up",
        });
        if (thread.has_next) {
          const total = thread.posts[rootId]?.reply_count ?? 0;
          const of = total > max ? ` of ${total}` : "";
          const more = max < 200 ? "pass limit=200 for more" : "older replies are out of reach";
          note = `\n(newest ${max} replies shown${of} — ${more})`;
        }
        list = thread;
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
      // The thread branch shows one post over the limit: `max` replies plus the root they hang off.
      const output = await ctx.formatPosts(list, { limit: rootId ? max + 1 : max, full });
      return { title: `Mattermost: ${resolved.name} (${scope})`, output: `${output}${note}` };
    },
  });
}

export function getPostTool(ctx: MattermostContext) {
  return tool({
    description:
      "Read one Mattermost post by id — its channel, author, body, reactions and attachments. Use it to check a single post (one just written, one named in a search hit) instead of reading the channel and filtering.",
    input: z.object({
      post_id: z.string().describe("26-char post id"),
      full: z
        .boolean()
        .optional()
        .describe("Print the message body in full instead of cutting it at 500 chars"),
    }),
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
    input: z.object({
      channel: z.string().optional().describe("Channel name or 26-char id"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max unread posts to fetch and show (default 30, max 200)"),
      full: z
        .boolean()
        .optional()
        .describe("Print message bodies in full instead of cutting them at 500 chars"),
    }),
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
          const unread = unreadCount(ch.total_msg_count, membership.msg_count);
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
      const unread = unreadCount(totals.total_msg_count, membership.msg_count);
      const mentions = membership.mention_count;
      if (unread <= 0 && mentions <= 0) {
        return {
          title: `Mattermost: unread in ${resolved.name}`,
          output: `No unread messages in ${resolved.name}.`,
        };
      }
      const me = await ctx.me();
      const max = limit ?? DEFAULT_LIMIT;
      const list = await ctx.client.getPostsUnread(resolved.id, me.id, max, CONTEXT_LIMIT);
      const note = membership.last_viewed_at === 0 ? `\n${FIRST_RUN_NOTE}` : "";
      const context = `plus up to ${CONTEXT_LIMIT} already-read posts for context`;
      // `total_msg_count - msg_count` over-counts on a real server: deleted posts and system
      // messages inflate the total, and a never-viewed channel reports its whole history. Measured
      // on 11.0.4, a channel holding 118 posts claimed 564 unread. So count what the unread window
      // actually returned — anything newer than the member's last view — and keep the counter
      // beside that number rather than above it.
      const unreadShown = list.order.filter((id) => {
        const post = list.posts[id];
        return post && !post.delete_at && post.create_at > membership.last_viewed_at;
      }).length;
      const counterNote = unreadShown === unread ? "" : ` (the channel counter says ${unread})`;
      // The server sets `next_post_id` when unread posts remain beyond the window it returned.
      let head: string;
      if (list.next_post_id) {
        head = `${resolved.name}: showing the oldest ${unreadShown} unread, ${context}; raise limit (max 200) for the rest${counterNote}`;
      } else if (unreadShown === 0) {
        head = `${resolved.name}: nothing unread on the server — the counter says ${unread}, but every post below is already read`;
      } else {
        head = `${resolved.name}: ${unreadShown} unread — all shown, ${context}${counterNote}`;
      }
      // The window is at most `limit_after + limit_before` posts, so this never trims. The paging
      // hint is off: this tool has no `before` argument, and `prev_post_id` points into read history.
      const body = await ctx.formatPosts(list, { limit: max + CONTEXT_LIMIT, full, paging: false });
      return {
        title: `Mattermost: unread in ${resolved.name}`,
        output: `${head}\n${body}${note}`,
      };
    },
  });
}
