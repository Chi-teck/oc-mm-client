import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { contains } from "../../paths.js";
import { humanSize, type MattermostContext, parseSchedule, unreadCount } from "../context.js";
import { confirmWrite } from "./confirm.js";
import { describeClientError } from "./registry.js";

/** The server's `MaxFileSize`, or undefined when it cannot be read — then the check falls open. */
async function maxFileSize(ctx: MattermostContext): Promise<number | undefined> {
  const config = await ctx.clientConfig().catch(() => undefined);
  const bytes = Number(config?.MaxFileSize);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

/** One attachment as the caller wrote it, beside the absolute path it was found at. */
interface Attachment {
  attachment: string;
  abs: string;
}

/**
 * Resolves `attachment` against `directory` — that is what a relative path means to the caller, and
 * re-anchoring it on the root the moment somebody sets the option would quietly move every file the
 * agent just wrote — then refuses anything that does not land under `root`. Both sides are
 * `realpath`ed, so a symlink inside the root cannot point out of it and a root reached through a
 * symlink still matches the paths under it; `root` arrives resolved, once per call.
 */
async function resolveUnder(root: string, directory: string, attachment: string): Promise<string> {
  const abs = resolve(directory, attachment);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT is a missing file, not an escape: hand it to the existence check in
    // `uploadAttachments`, which already words it well, rather than reporting a typo as a security
    // refusal. Nothing leaves the machine either way — a path that does not exist cannot be read.
    // Anything else — EACCES on a parent, ELOOP — is refused here, since it left the question open.
    if (code === "ENOENT") return abs;
    throw new Error(`Attachment cannot be resolved: ${attachment} (${code ?? String(error)})`);
  }
  const where = contains(root, real);
  if (where === "root") throw new Error(`Attachment is ${root} itself, not a file: ${attachment}`);
  if (where === "outside") {
    // The second clause is not decoration. The first person to hit this line is someone whose
    // working `/tmp/report.pdf` stopped uploading after a version bump; naming the option turns
    // that into a one-line fix instead of a hunt through the README.
    throw new Error(
      `Attachment outside ${root}: ${attachment} (resolved to ${real}) — set the uploadRoot plugin option to allow it`,
    );
  }
  // The path as the caller would recognise it, not its `realpath`: the confirmation names it.
  return abs;
}

async function uploadAttachments(
  ctx: MattermostContext,
  channelId: string,
  files: Attachment[],
): Promise<string[]> {
  // Check every path before uploading any: a second file that is missing or over the server's
  // limit would otherwise leave the first one orphaned, since the post that would carry it is
  // never created. `resolveUnder` is the third member of that family and runs earlier still, before
  // the caller is even asked. This only rules out the failures visible from here — the upload loop
  // below still has to own the ones that are not.
  const blobs = files.map(({ abs, attachment }) => ({ abs, blob: Bun.file(abs), attachment }));
  for (const { abs, blob, attachment } of blobs) {
    if (!(await blob.exists())) {
      throw new Error(`Attachment not found: ${attachment} (resolved to ${abs})`);
    }
  }
  const limit = await maxFileSize(ctx);
  for (const { blob, attachment } of blobs) {
    if (limit !== undefined && blob.size > limit) {
      throw new Error(
        `Attachment too large: ${attachment} is ${humanSize(blob.size)}, over the server limit of ${humanSize(limit)}`,
      );
    }
  }
  const fileIds: string[] = [];
  for (const { abs, blob, attachment } of blobs) {
    const form = new FormData();
    form.append("channel_id", channelId);
    form.append("files", blob, basename(abs));
    try {
      const response = await ctx.client.uploadFile(form);
      for (const info of response.file_infos ?? []) fileIds.push(info.id);
    } catch (error) {
      // Mattermost deletes a file only with the post that carries it, so ids already uploaded
      // stay on the server forever once this post is abandoned. Name them instead of leaving the
      // caller to guess what was left behind.
      if (!fileIds.length) throw error;
      const described = describeClientError(error);
      const reason = described instanceof Error ? described.message : String(described);
      throw new Error(
        `Uploaded ${fileIds.length} file(s), then ${attachment} failed — file ids ${fileIds.join(", ")} are orphaned on the server and cannot be deleted (Mattermost only deletes a file with the post that carries it). Cause: ${reason}`,
        { cause: error },
      );
    }
  }
  return fileIds;
}

export function createPostTool(ctx: MattermostContext) {
  return tool({
    description:
      "Post a message to a Mattermost channel, optionally as a thread reply (thread_root_id) with file attachments (paths relative to the working directory), now or scheduled for later (schedule_at).",
    args: {
      channel: tool.schema.string().describe("Channel name or 26-char id"),
      message: tool.schema.string().describe("Message text (markdown supported)"),
      thread_root_id: tool.schema.string().optional().describe("Root post id to reply in a thread"),
      schedule_at: tool.schema
        .string()
        .optional()
        .describe('Send later instead of now: "30m", "2h", "3d", ISO date, or epoch ms'),
      attachments: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("File paths to attach"),
    },
    execute: async (
      { channel, message, thread_root_id: rootId, schedule_at: scheduleAt, attachments },
      tctx,
    ) => {
      if (!message.trim() && !attachments?.length) {
        throw new Error("Refusing to post an empty message with no attachments");
      }
      // Parsed here for the same reason the attachment paths are: a time the server was never going
      // to accept should not cost a human a decision, nor leave uploads orphaned behind a refusal.
      const at = scheduleAt === undefined ? undefined : parseSchedule(scheduleAt);
      // Before the channel lookup and before the prompt, both. A path that was never going to be
      // allowed should not cost a human a decision, and a refusal that landed mid-upload would
      // leave the files before it orphaned on the server; that it also saves a round trip on the
      // way out is a side effect. The root is `realpath`ed once here — a root that cannot be
      // resolved falls back to the path as written, which can only refuse more, never less.
      const root = ctx.uploadRoot ?? tctx.worktree;
      const files: Attachment[] = [];
      if (attachments?.length) {
        const real = await realpath(root).catch(() => resolve(root));
        // Sequential, so two bad attachments report in the order the caller wrote them.
        for (const attachment of attachments) {
          files.push({ attachment, abs: await resolveUnder(real, tctx.directory, attachment) });
        }
      }
      const resolved = await ctx.resolveChannel(channel);
      // Spell out the resolved paths: they are confined to the root above, so approving the post is
      // also approving the upload of these exact files.
      const summary = files.length ? ` [files: ${files.map((f) => f.abs).join(", ")}]` : "";
      // Name the time in the prompt: approving a scheduled post is approving a send that happens
      // later, with nobody watching. With the zone, because the clock is this host's and the human
      // reading the prompt may not be on it — "10:00 AM" alone is only half an instant.
      const localAt =
        at === undefined
          ? undefined
          : new Date(at).toLocaleString(undefined, { timeZoneName: "short" });
      // Confirm before uploading, so a declined post leaves no orphaned files on the server.
      await confirmWrite(
        tctx,
        "mattermost_create_post",
        `mattermost_create_post ${resolved.name}${rootId ? ` (thread ${rootId})` : ""}: ${message.slice(0, 120)}${summary}${localAt ? ` [send at ${localAt}]` : ""}`,
      );
      const fileIds = files.length ? await uploadAttachments(ctx, resolved.id, files) : [];
      const payload = {
        channel_id: resolved.id,
        message,
        ...(rootId ? { root_id: rootId } : {}),
        ...(fileIds.length ? { file_ids: fileIds } : {}),
      };
      const filesNote = fileIds.length ? `, ${fileIds.length} file(s)` : "";
      if (at !== undefined) {
        // `connectionId` is required by the signature and only suppresses the caller's own
        // WebSocket echo; this client has no socket, so "". The response is a `ClientResponse`
        // rather than the post itself, so the id sits under `.data`.
        const { data } = await ctx.client.createScheduledPost({ ...payload, scheduled_at: at }, "");
        return {
          title: `Mattermost: schedule post to ${resolved.name}`,
          output: `Scheduled for ${localAt} in ${resolved.name} (scheduled post id: ${data.id}${filesNote})`,
        };
      }
      const post = await ctx.client.createPost(payload);
      return {
        title: `Mattermost: post to ${resolved.name}`,
        output: `Posted to ${resolved.name} (post id: ${post.id}${filesNote})`,
      };
    },
  });
}

export function reactTool(ctx: MattermostContext) {
  return tool({
    description:
      "Add or remove an emoji reaction on a Mattermost post (emoji name without colons, e.g. thumbsup).",
    args: {
      post_id: tool.schema.string().describe("Post id"),
      emoji: tool.schema.string().describe("Emoji name without colons, e.g. thumbsup"),
      action: tool.schema.enum(["add", "remove"]).describe("Add or remove the reaction"),
    },
    execute: async ({ post_id: postId, emoji, action }, tctx) => {
      // Confirm first, check second. The existence check below is a read with the user's token,
      // so it must not run on a call the user is about to deny, and keeping it behind the gate
      // leaves "did I react to post X" unanswerable without a prompt. A remove that turns out to
      // be a no-op therefore still costs one prompt — deliberate, not an oversight.
      await confirmWrite(
        tctx,
        "mattermost_react",
        `mattermost_react ${action} :${emoji}: on ${postId}`,
      );
      const me = await ctx.me();
      if (action === "add") {
        await ctx.client.addReaction(me.id, postId, emoji);
      } else {
        // Mattermost answers 200 whether or not the reaction was there, so check first rather
        // than report a removal that never happened.
        const existing = await ctx.client.getReactionsForPost(postId);
        if (!existing.some((r) => r.user_id === me.id && r.emoji_name === emoji)) {
          return {
            title: `Mattermost: remove :${emoji}:`,
            output: `No :${emoji}: reaction by you on post ${postId} — nothing to remove.`,
          };
        }
        await ctx.client.removeReaction(me.id, postId, emoji);
      }
      const verb = action === "add" ? "Added" : "Removed";
      const prep = action === "add" ? "on" : "from";
      return {
        title: `Mattermost: ${action} :${emoji}:`,
        output: `${verb} :${emoji}: ${prep} post ${postId}`,
      };
    },
  });
}

export function followThreadTool(ctx: MattermostContext) {
  return tool({
    description: "Follow a Mattermost thread, so the bot stays subscribed to its replies.",
    args: {
      thread_root_id: tool.schema.string().describe("Root post id of the thread"),
    },
    execute: async ({ thread_root_id: rootId }) => {
      const [me, team] = await Promise.all([ctx.me(), ctx.team()]);
      await ctx.client.updateThreadFollowForUser(me.id, team.id, rootId, true);
      return {
        title: "Mattermost: follow thread",
        output: `Following thread ${rootId}`,
      };
    },
  });
}

export function unfollowThreadTool(ctx: MattermostContext) {
  return tool({
    description:
      "Stop following a Mattermost thread — the way out of a conversation the bot was pulled into.",
    args: {
      thread_root_id: tool.schema.string().describe("Root post id of the thread"),
    },
    execute: async ({ thread_root_id: rootId }) => {
      const [me, team] = await Promise.all([ctx.me(), ctx.team()]);
      // The server answers 200 whether or not the thread was followed, and no check runs first:
      // unlike a reaction removal, the end state is the one that was asked for either way.
      await ctx.client.updateThreadFollowForUser(me.id, team.id, rootId, false);
      return {
        title: "Mattermost: unfollow thread",
        output: `Left thread ${rootId} — posting in it again re-follows it.`,
      };
    },
  });
}

export function markReadTool(ctx: MattermostContext) {
  return tool({
    description: "Mark a Mattermost channel as read (clears its unread state).",
    args: {
      channel: tool.schema.string().describe("Channel name or 26-char id"),
    },
    execute: async ({ channel }) => {
      const resolved = await ctx.resolveChannel(channel);
      // Read the counters before clearing them — afterwards there is nothing left to count, and
      // the resolved channel may be a cached copy with a stale total.
      const [totals, membership] = await Promise.all([
        ctx.client.getChannel(resolved.id),
        ctx.client.getChannelMember(resolved.id, "me"),
      ]);
      const unread = unreadCount(totals.total_msg_count, membership.msg_count);
      const mentions = membership.mention_count;
      if (unread === 0 && mentions === 0) {
        return {
          title: `Mattermost: ${resolved.name} already read`,
          output: `${resolved.name} was already read — nothing to clear.`,
        };
      }
      await ctx.client.viewMyChannel(resolved.id);
      const plural = mentions === 1 ? "" : "s";
      return {
        title: `Mattermost: marked ${resolved.name} read`,
        output: `Marked ${resolved.name} read: ${unread} unread, ${mentions} mention${plural} cleared.`,
      };
    },
  });
}
