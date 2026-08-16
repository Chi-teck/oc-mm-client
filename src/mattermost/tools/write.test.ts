import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { Client4 } from "@mattermost/client";
import type { ChannelMembership, ServerChannel } from "@mattermost/types/channels";
import type { ToolContext } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import { createPostTool, markReadTool, reactTool } from "./write.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };
const ME_ID = "uuuuuuuuuuuuuuuuuuuuuuuuu1";
const TEAM_ID = "tttttttttttttttttttttttttt";
const CHANNEL_ID = "ccccccccccccccccccccccccc1";
const FILE_ID = "ffffffffffffffffffffffff01";

const toolCtx = (onAsk?: (input: unknown) => Promise<void>) =>
  ({
    sessionID: "s",
    messageID: "m",
    agent: "a",
    directory: "local/tmp",
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: onAsk ?? (async () => {}),
  }) as ToolContext;

function recordingCtx() {
  const asks: unknown[] = [];
  return { asks, tctx: toolCtx(async (input) => void asks.push(input)) };
}

const rejectingCtx = () =>
  toolCtx(async () => {
    throw new Error("The user rejected permission to use this specific tool call.");
  });

interface MockState {
  order: string[];
  uploads: FormData[];
  createdPosts: unknown[];
  reactions: { user_id: string; emoji_name: string }[];
  membership: ChannelMembership;
}

function mockClient(state: Partial<MockState> = {}): Client4 & { state: MockState } {
  const s: MockState = {
    order: [],
    uploads: [],
    createdPosts: [],
    reactions: [{ user_id: ME_ID, emoji_name: "eyes" }],
    membership: {
      channel_id: CHANNEL_ID,
      msg_count: 7,
      mention_count: 2,
      last_viewed_at: 1_700_000_000_000,
    } as ChannelMembership,
    ...state,
  };
  const rec = (name: string) => s.order.push(name);
  const channel = (): ServerChannel =>
    ({
      id: CHANNEL_ID,
      name: "my-channel",
      display_name: "my-channel",
      type: "P",
      total_msg_count: 10,
    }) as ServerChannel;
  return {
    getMe: async () => ({ id: ME_ID, username: "mmbot" }),
    getTeamByName: async (name: string) => ({ id: TEAM_ID, name }),
    getChannelByName: async (_teamId: string, name: string) => {
      if (name === "my-channel") return channel();
      throw new Error("not found");
    },
    getMyChannels: async () => [channel()],
    getMyChannelMembers: async () =>
      [
        { channel_id: CHANNEL_ID, msg_count: 0, mention_count: 0, last_viewed_at: 0 },
      ] as ChannelMembership[],
    getChannel: async () => {
      rec("getChannel");
      return channel();
    },
    getChannelMember: async () => {
      rec("getChannelMember");
      return s.membership;
    },
    uploadFile: async (form: FormData) => {
      rec("uploadFile");
      s.uploads.push(form);
      return { file_infos: [{ id: FILE_ID }], client_ids: ["c1"] };
    },
    createPost: async (post: unknown) => {
      rec("createPost");
      s.createdPosts.push(post);
      return { id: "newpostttttttttttttttttttttt", message: "x", channel_id: CHANNEL_ID };
    },
    addReaction: async (userId: string, postId: string, emojiName: string) => {
      rec("addReaction");
      s.order.push(`${userId}:${postId}:${emojiName}`);
      return { user_id: userId, post_id: postId, emoji_name: emojiName };
    },
    removeReaction: async (userId: string, postId: string, emojiName: string) => {
      rec("removeReaction");
      s.order.push(`${userId}:${postId}:${emojiName}`);
      return { status: "ok" };
    },
    getReactionsForPost: async (postId: string) => {
      rec("getReactionsForPost");
      return s.reactions.map((r) => ({ ...r, post_id: postId }));
    },
    viewMyChannel: async (channelId: string) => {
      rec("viewMyChannel");
      s.order.push(channelId);
      return { status: "ok", prev_channel_id: "", last_viewed_at_times: {} };
    },
    state: s,
  } as unknown as Client4 & { state: MockState };
}

describe("mattermost_create_post", () => {
  it("refuses a blank message with no attachments, before asking or calling the API", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await expect(
      createPostTool(ctx).execute({ channel: "my-channel", message: "   " }, tctx),
    ).rejects.toThrow("Refusing to post an empty message with no attachments");
    expect(asks).toEqual([]);
    expect(client.state.order).toEqual([]);
  });

  it("allows a blank message when attachments carry the post", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await createPostTool(ctx).execute(
      { channel: "my-channel", message: "", attachments: ["attach.txt"] },
      recordingCtx().tctx,
    );
    expect(client.state.createdPosts[0]).toMatchObject({ message: "" });
  });

  it("uploads attachments before posting and wires file_ids", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await createPostTool(ctx).execute(
      { channel: "my-channel", message: "with file", attachments: ["attach.txt"] },
      recordingCtx().tctx,
    );
    const uploadIdx = client.state.order.indexOf("uploadFile");
    const postIdx = client.state.order.indexOf("createPost");
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(uploadIdx).toBeLessThan(postIdx);
    expect(client.state.createdPosts[0]).toEqual({
      channel_id: CHANNEL_ID,
      message: "with file",
      file_ids: [FILE_ID],
    });
    const upload = client.state.uploads[0];
    if (!upload) throw new Error("no upload recorded");
    expect(upload.get("channel_id")).toBe(CHANNEL_ID);
    const wire = await new Response(upload).text();
    expect(wire).toContain('name="files"; filename="attach.txt"');
    expect(wire).toContain("hello attachment");
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("post id: newpostttttttttttttttttttttt");
    expect(output).toContain("1 file(s)");
  });

  it("posts without attachments and skips upload entirely", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await createPostTool(ctx).execute({ channel: "my-channel", message: "plain" }, toolCtx());
    expect(client.state.order).toEqual(["createPost"]);
    expect(client.state.createdPosts[0]).toEqual({ channel_id: CHANNEL_ID, message: "plain" });
  });

  it("passes root_id through for thread replies", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await createPostTool(ctx).execute(
      { channel: "my-channel", message: "reply", thread_root_id: "rrrrrrrrrrrrrrrrrrrrrrrrrr" },
      recordingCtx().tctx,
    );
    expect(client.state.createdPosts[0]).toEqual({
      channel_id: CHANNEL_ID,
      message: "reply",
      root_id: "rrrrrrrrrrrrrrrrrrrrrrrrrr",
    });
  });

  it("throws on missing attachment file", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: ["nope.txt"] },
        recordingCtx().tctx,
      ),
    ).rejects.toThrow("Attachment not found");
    expect(client.state.order).toEqual([]);
  });

  it("uploads nothing when a later attachment is missing", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: ["attach.txt", "nope.txt"] },
        recordingCtx().tctx,
      ),
    ).rejects.toThrow("Attachment not found: nope.txt");
    expect(client.state.order).toEqual([]);
  });

  it("requires a message (zod)", () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const args = createPostTool(ctx).args;
    const parsed = tool.schema.object(args).safeParse({ channel: "my-channel" });
    expect(parsed.success).toBe(false);
  });
});

describe("mattermost_react", () => {
  it("routes add to addReaction with own user id", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await reactTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", emoji: "thumbsup", action: "add" },
      recordingCtx().tctx,
    );
    expect(client.state.order).toEqual([
      "addReaction",
      `${ME_ID}:ppppppppppppppppppppppppp1:thumbsup`,
    ]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("Added :thumbsup: on post ppppppppppppppppppppppppp1");
  });

  it("routes remove to removeReaction", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await reactTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", emoji: "eyes", action: "remove" },
      recordingCtx().tctx,
    );
    expect(client.state.order).toEqual([
      "getReactionsForPost",
      "removeReaction",
      `${ME_ID}:ppppppppppppppppppppppppp1:eyes`,
    ]);
  });

  it("reports nothing to remove instead of a false success", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await reactTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", emoji: "heart", action: "remove" },
      recordingCtx().tctx,
    );
    expect(client.state.order).toEqual(["getReactionsForPost"]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe(
      "No :heart: reaction by you on post ppppppppppppppppppppppppp1 — nothing to remove.",
    );
  });

  it("does not remove another user's reaction of the same emoji", async () => {
    const client = mockClient({ reactions: [{ user_id: "someone-else", emoji_name: "eyes" }] });
    const ctx = createMattermostContext(config, client);
    await reactTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", emoji: "eyes", action: "remove" },
      recordingCtx().tctx,
    );
    expect(client.state.order).toEqual(["getReactionsForPost"]);
  });
});

describe("permission gating (ctx.ask)", () => {
  it("create_post asks with permission name and summary before any API write", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await createPostTool(ctx).execute({ channel: "my-channel", message: "gated" }, tctx);
    expect(asks).toHaveLength(1);
    const ask = asks[0] as { permission: string; patterns: string[] };
    expect(ask.permission).toBe("mattermost_create_post");
    expect(ask.patterns[0]).toContain("my-channel");
    expect(ask.patterns[0]).toContain("gated");
    expect(client.state.order).toContain("createPost");
  });

  it("create_post names the resolved attachment paths in the summary", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await createPostTool(ctx).execute(
      { channel: "my-channel", message: "with file", attachments: ["attach.txt"] },
      tctx,
    );
    const ask = asks[0] as { patterns: string[] };
    expect(ask.patterns[0]).toContain(`[files: ${resolve("local/tmp", "attach.txt")}]`);
  });

  it("create_post performs no API calls when the ask is rejected", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await expect(
      createPostTool(ctx).execute({ channel: "my-channel", message: "nope" }, rejectingCtx()),
    ).rejects.toThrow("rejected permission");
    expect(client.state.order).toEqual([]);
  });

  it("react asks; mark_read never asks", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await reactTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", emoji: "eyes", action: "add" },
      tctx,
    );
    expect(asks).toHaveLength(1);
    expect((asks[0] as { permission: string }).permission).toBe("mattermost_react");
    const result = await markReadTool(ctx).execute({ channel: "my-channel" }, rejectingCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("Marked my-channel read: 3 unread, 2 mentions cleared.");
  });
});

describe("mattermost_mark_read", () => {
  it("marks the resolved channel viewed and reports what it cleared", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await markReadTool(ctx).execute({ channel: "my-channel" }, toolCtx());
    expect(client.state.order).toEqual([
      "getChannel",
      "getChannelMember",
      "viewMyChannel",
      CHANNEL_ID,
    ]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("Marked my-channel read: 3 unread, 2 mentions cleared.");
  });

  it("writes a single mention in the singular", async () => {
    const client = mockClient({
      membership: {
        channel_id: CHANNEL_ID,
        msg_count: 9,
        mention_count: 1,
        last_viewed_at: 1,
      } as ChannelMembership,
    });
    const ctx = createMattermostContext(config, client);
    const result = await markReadTool(ctx).execute({ channel: "my-channel" }, toolCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("Marked my-channel read: 1 unread, 1 mention cleared.");
  });

  it("says nothing was unread instead of claiming a clear that did nothing", async () => {
    const client = mockClient({
      membership: {
        channel_id: CHANNEL_ID,
        msg_count: 10,
        mention_count: 0,
        last_viewed_at: 1,
      } as ChannelMembership,
    });
    const ctx = createMattermostContext(config, client);
    const result = await markReadTool(ctx).execute({ channel: "my-channel" }, toolCtx());
    expect(client.state.order).toEqual(["getChannel", "getChannelMember"]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("my-channel was already read — nothing to clear.");
  });
});
