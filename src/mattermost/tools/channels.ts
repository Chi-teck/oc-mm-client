import { tool } from "@opencode-ai/plugin";
import type { MattermostContext } from "../context.js";

export function listChannelsTool(ctx: MattermostContext) {
  return tool({
    description:
      "List the Mattermost channels this bot is a member of, as `name — display_name [type]`.",
    args: {},
    execute: async () => {
      const team = await ctx.team();
      const channels = await ctx.client.getMyChannels(team.id);
      const lines = channels.map(
        (channel) =>
          `- ${channel.name} — ${channel.display_name || channel.name} [${channel.type}]`,
      );
      return {
        title: `Mattermost: ${channels.length} channels`,
        output: lines.length ? lines.join("\n") : "No channels found.",
      };
    },
  });
}
