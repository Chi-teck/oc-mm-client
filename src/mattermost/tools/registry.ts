import { ClientError } from "@mattermost/client";
import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MattermostContext } from "../context.js";
import { apiTool } from "./api.js";
import { listChannelsTool } from "./channels.js";
import { getFileTool } from "./files.js";
import { dmTool, editPostTool, listMembersTool, searchTool } from "./misc.js";
import { getPostTool, readPostsTool, readUnreadTool } from "./read.js";
import {
  createPostTool,
  followThreadTool,
  markReadTool,
  reactTool,
  unfollowThreadTool,
} from "./write.js";

/**
 * Client4 throws the server's own sentence and nothing else — "Unable to get the post." names
 * neither the status nor the endpoint, and a broken response leaves the message empty. Restate it
 * so the caller can tell a 404 from a 403 without unwrapping the error.
 */
export function describeClientError(error: unknown): unknown {
  if (!(error instanceof ClientError)) return error;
  const status = error.status_code ? ` ${error.status_code}` : "";
  const endpoint = error.url ? ` ${error.url.replace(/^[a-z]+:\/\/[^/]*/i, "")}` : "";
  const message = error.message || "the server sent no message";
  return new Error(`Mattermost API${status}${endpoint}: ${message}`, { cause: error });
}

function withReadableErrors(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    execute: async (args, tctx) => {
      try {
        return await definition.execute(args, tctx);
      } catch (error) {
        throw describeClientError(error);
      }
    },
  };
}

export function createTools(ctx: MattermostContext): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {
    mattermost_list_channels: listChannelsTool(ctx),
    mattermost_read_posts: readPostsTool(ctx),
    mattermost_get_post: getPostTool(ctx),
    mattermost_read_unread: readUnreadTool(ctx),
    mattermost_mark_read: markReadTool(ctx),
    mattermost_create_post: createPostTool(ctx),
    mattermost_react: reactTool(ctx),
    mattermost_follow_thread: followThreadTool(ctx),
    mattermost_unfollow_thread: unfollowThreadTool(ctx),
    mattermost_get_file: getFileTool(ctx),
    mattermost_edit_post: editPostTool(ctx),
    mattermost_search: searchTool(ctx),
    mattermost_list_members: listMembersTool(ctx),
    mattermost_dm: dmTool(ctx),
    mattermost_api: apiTool(ctx),
  };
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [name, withReadableErrors(definition)]),
  );
}
