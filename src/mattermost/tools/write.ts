import { basename, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";
import type { MattermostContext } from "../context.js";
import { confirmWrite } from "./confirm.js";

async function uploadAttachments(
  ctx: MattermostContext,
  channelId: string,
  attachments: string[],
  directory: string,
): Promise<string[]> {
  // Check every path before uploading any: a missing second file would otherwise leave the
  // first one orphaned on the server, since the post that would carry it is never created.
  const blobs = attachments.map((attachment) => {
    const abs = resolve(directory, attachment);
    return { abs, blob: Bun.file(abs), attachment };
  });
  for (const { abs, blob, attachment } of blobs) {
    if (!(await blob.exists())) {
      throw new Error(`Attachment not found: ${attachment} (resolved to ${abs})`);
    }
  }
  const fileIds: string[] = [];
  for (const { abs, blob } of blobs) {
    const form = new FormData();
    form.append("channel_id", channelId);
    form.append("files", blob, basename(abs));
    const response = await ctx.client.uploadFile(form);
    for (const info of response.file_infos ?? []) fileIds.push(info.id);
  }
  return fileIds;
}

export function createPostTool(ctx: MattermostContext) {
  return tool({
    description:
      "Post a message to a Mattermost channel, optionally as a thread reply (thread_root_id) with file attachments (paths relative to the working directory).",
    args: {
      channel: tool.schema.string().describe("Channel name or 26-char id"),
      message: tool.schema.string().describe("Message text (markdown supported)"),
      thread_root_id: tool.schema.string().optional().describe("Root post id to reply in a thread"),
      attachments: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("File paths to attach"),
    },
    execute: async ({ channel, message, thread_root_id: rootId, attachments }, tctx) => {
      if (!message.trim() && !attachments?.length) {
        throw new Error("Refusing to post an empty message with no attachments");
      }
      const resolved = await ctx.resolveChannel(channel);
      // Spell out the resolved paths: attachments are read from anywhere the process can reach,
      // so approving the post is also approving the upload of these exact files.
      const files = attachments?.length
        ? ` [files: ${attachments.map((path) => resolve(tctx.directory, path)).join(", ")}]`
        : "";
      // Confirm before uploading, so a declined post leaves no orphaned files on the server.
      await confirmWrite(
        tctx,
        "mattermost_create_post",
        `mattermost_create_post ${resolved.name}${rootId ? ` (thread ${rootId})` : ""}: ${message.slice(0, 120)}${files}`,
      );
      const fileIds = attachments?.length
        ? await uploadAttachments(ctx, resolved.id, attachments, tctx.directory)
        : [];
      const post = await ctx.client.createPost({
        channel_id: resolved.id,
        message,
        ...(rootId ? { root_id: rootId } : {}),
        ...(fileIds.length ? { file_ids: fileIds } : {}),
      });
      const filesNote = fileIds.length ? `, ${fileIds.length} file(s)` : "";
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

export function markReadTool(ctx: MattermostContext) {
  return tool({
    description: "Mark a Mattermost channel as read (clears its unread state).",
    args: {
      channel: tool.schema.string().describe("Channel name or 26-char id"),
    },
    execute: async ({ channel }) => {
      const resolved = await ctx.resolveChannel(channel);
      await ctx.client.viewMyChannel(resolved.id);
      return {
        title: `Mattermost: marked ${resolved.name} read`,
        output: `Marked ${resolved.name} read.`,
      };
    },
  });
}
