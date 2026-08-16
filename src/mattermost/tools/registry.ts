import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MattermostContext } from "../context.js";
import { listChannelsTool } from "./channels.js";
import { getFileTool } from "./files.js";
import { dmTool, editPostTool, listMembersTool, searchTool } from "./misc.js";
import { readPostsTool, readUnreadTool } from "./read.js";
import { createPostTool, markReadTool, reactTool } from "./write.js";

export function createTools(ctx: MattermostContext): Record<string, ToolDefinition> {
  return {
    mattermost_list_channels: listChannelsTool(ctx),
    mattermost_read_posts: readPostsTool(ctx),
    mattermost_read_unread: readUnreadTool(ctx),
    mattermost_mark_read: markReadTool(ctx),
    mattermost_create_post: createPostTool(ctx),
    mattermost_react: reactTool(ctx),
    mattermost_get_file: getFileTool(ctx),
    mattermost_edit_post: editPostTool(ctx),
    mattermost_search: searchTool(ctx),
    mattermost_list_members: listMembersTool(ctx),
    mattermost_dm: dmTool(ctx),
  };
}
