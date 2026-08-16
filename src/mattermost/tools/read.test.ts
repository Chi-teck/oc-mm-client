import { describe, expect, it } from "bun:test";
import type { Client4 } from "@mattermost/client";
import type { ChannelMembership, ServerChannel } from "@mattermost/types/channels";
import type { Post, PostList } from "@mattermost/types/posts";
import type { Reaction } from "@mattermost/types/reactions";
import type { ToolContext } from "@opencode-ai/plugin";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import { listChannelsTool } from "./channels.js";
import { readPostsTool, readUnreadTool } from "./read.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };
const ME_ID = "uuuuuuuuuuuuuuuuuuuuuuuuu1";
const TEAM_ID = "tttttttttttttttttttttttttt";
const CHANNEL_ID = "ccccccccccccccccccccccccc1";

const toolCtx = {
  sessionID: "s",
  messageID: "m",
  agent: "a",
  directory: "/tmp/opencode",
  worktree: "/tmp/opencode",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
} as ToolContext;

let seq = 0;
function post(overrides: Partial<Post> = {}): Post {
  seq += 1;
  return {
    id: `ppppppppppppppppppppppp${String(seq).padStart(2, "0")}`,
    create_at: 1_700_000_000_000 + seq * 1000,
    update_at: 0,
    edit_at: 0,
    delete_at: 0,
    is_pinned: false,
    user_id: ME_ID,
    channel_id: CHANNEL_ID,
    root_id: "",
    original_id: "",
    message: `message ${seq}`,
    type: "",
    props: {},
    hashtags: "",
    pending_post_id: "",
    reply_count: 0,
    metadata: { embeds: [], emojis: [], files: [], images: {} },
    ...overrides,
  };
}

function reaction(userId: string, emoji: string): Reaction {
  return {
    user_id: userId,
    post_id: "ppppppppppppppppppppppp01",
    emoji_name: emoji,
    create_at: 1_700_000_000_000,
  };
}

function postList(posts: Post[]): PostList {
  const order = [...posts].sort((a, b) => b.create_at - a.create_at).map((p) => p.id);
  return {
    order,
    posts: Object.fromEntries(posts.map((p) => [p.id, p])),
    next_post_id: "",
    prev_post_id: "",
    first_inaccessible_post_time: 0,
  };
}

interface MockState {
  calls: Record<string, unknown[]>;
  posts: Post[];
}

const MEMBERSHIPS = [
  {
    channel_id: CHANNEL_ID,
    msg_count: 8,
    mention_count: 2,
    last_viewed_at: 1_700_000_500_000,
  },
  {
    channel_id: "dddddddddddddddddddddddddd",
    msg_count: 3,
    mention_count: 0,
    last_viewed_at: 0,
  },
  {
    channel_id: "eeeeeeeeeeeeeeeeeeeeeeeeee",
    msg_count: 0,
    mention_count: 0,
    last_viewed_at: 1_700_000_000_000,
  },
] as ChannelMembership[];

function mockClient(state: Partial<MockState> = {}): Client4 & { state: MockState } {
  const s: MockState = { calls: {}, posts: [], ...state };
  const rec = (name: string, ...args: unknown[]) => {
    if (!s.calls[name]) s.calls[name] = [];
    s.calls[name].push(args);
  };
  const channel = (): ServerChannel =>
    ({
      id: CHANNEL_ID,
      name: "my-channel",
      display_name: "my-channel",
      type: "P",
      total_msg_count: 10,
    }) as ServerChannel;
  return {
    getMe: async () => {
      rec("getMe");
      return { id: ME_ID, username: "mmbot" };
    },
    getTeamByName: async (name: string) => {
      rec("getTeamByName", name);
      return { id: TEAM_ID, name };
    },
    getChannelByName: async (teamId: string, name: string) => {
      rec("getChannelByName", teamId, name);
      if (name === "my-channel") return channel();
      if (name === "empty")
        return {
          id: "eeeeeeeeeeeeeeeeeeeeeeeeee",
          name: "empty",
          display_name: "Empty",
          type: "O",
          total_msg_count: 0,
        } as ServerChannel;
      throw new Error("not found");
    },
    getMyChannels: async () => {
      rec("getMyChannels");
      return [
        channel(),
        {
          id: "dddddddddddddddddddddddddd",
          name: "alice__mmbot",
          display_name: "",
          type: "D",
          total_msg_count: 5,
        },
        {
          id: "eeeeeeeeeeeeeeeeeeeeeeeeee",
          name: "empty",
          display_name: "Empty",
          type: "O",
          total_msg_count: 0,
        },
      ] as ServerChannel[];
    },
    getMyChannelMembers: async () => {
      rec("getMyChannelMembers");
      return MEMBERSHIPS;
    },
    getChannel: async (channelId: string) => {
      rec("getChannel", channelId);
      if (channelId === CHANNEL_ID) return channel();
      return {
        id: channelId,
        name: "empty",
        display_name: "Empty",
        type: "O",
        total_msg_count: 0,
      } as ServerChannel;
    },
    getChannelMember: async (channelId: string, userId: string) => {
      rec("getChannelMember", channelId, userId);
      const membership = MEMBERSHIPS.find((m) => m.channel_id === channelId);
      if (!membership) throw new Error("not a member");
      return membership;
    },
    getPosts: async (channelId: string, page?: number, perPage?: number) => {
      rec("getPosts", channelId, page, perPage);
      return postList(s.posts);
    },
    getPostsSince: async (channelId: string, since: number) => {
      rec("getPostsSince", channelId, since);
      return postList(s.posts.filter((p) => p.create_at > since));
    },
    getPostsBefore: async (channelId: string, postId: string, page?: number, perPage?: number) => {
      rec("getPostsBefore", channelId, postId, page, perPage);
      const pivot = s.posts.find((p) => p.id === postId);
      return postList(pivot ? s.posts.filter((p) => p.create_at < pivot.create_at) : s.posts);
    },
    getPostThread: async (postId: string) => {
      rec("getPostThread", postId);
      return { ...postList(s.posts), has_next: false };
    },
    getPinnedPosts: async (channelId: string) => {
      rec("getPinnedPosts", channelId);
      return postList(s.posts.filter((p) => p.is_pinned));
    },
    getPostsUnread: async (channelId: string, userId: string, limitAfter?: number) => {
      rec("getPostsUnread", channelId, userId, limitAfter);
      return postList(s.posts);
    },
    getProfilesByIds: async (userIds: string[]) => {
      rec("getProfilesByIds", userIds);
      return userIds.includes(ME_ID) ? [{ id: ME_ID, username: "mmbot" }] : [];
    },
    getFileInfosForPost: async (postId: string) => {
      rec("getFileInfosForPost", postId);
      return [
        {
          id: "ffffffffffffffffffffffff01",
          name: "report.pdf",
          mime_type: "application/pdf",
          size: 4300,
        },
      ];
    },
    state: s,
  } as unknown as Client4 & { state: MockState };
}

function makeTools(client: Client4 & { state: MockState }) {
  const ctx = createMattermostContext(config, client);
  return {
    listChannels: listChannelsTool(ctx).execute,
    readPosts: readPostsTool(ctx).execute,
    readUnread: readUnreadTool(ctx).execute,
    calls: client.state.calls,
  };
}

describe("mattermost_list_channels", () => {
  it("lists channels with name, display name and type", async () => {
    const client = mockClient();
    const { listChannels } = makeTools(client);
    const result = await listChannels({}, toolCtx);
    expect(result).toEqual({
      title: "Mattermost: 3 channels",
      output: [
        "- my-channel — my-channel [P]",
        "- alice__mmbot — alice__mmbot [D]",
        "- empty — Empty [O]",
      ].join("\n"),
    });
  });
});

describe("mattermost_read_posts", () => {
  it("defaults to getPosts with limit 30", async () => {
    const client = mockClient();
    const { readPosts, calls } = makeTools(client);
    await readPosts({ channel: "my-channel" }, toolCtx);
    expect(calls.getPosts).toEqual([[CHANNEL_ID, 0, 30]]);
  });

  it("passes limit through", async () => {
    const client = mockClient();
    const { readPosts, calls } = makeTools(client);
    await readPosts({ channel: "my-channel", limit: 10 }, toolCtx);
    expect(calls.getPosts).toEqual([[CHANNEL_ID, 0, 10]]);
  });

  it("uses getPostsSince with parsed since", async () => {
    const client = mockClient({ posts: [post()] });
    const { readPosts, calls } = makeTools(client);
    await readPosts({ channel: "my-channel", since: "2h" }, toolCtx);
    expect(calls.getPostsSince).toHaveLength(1);
    const args = calls.getPostsSince?.[0] as unknown[];
    expect(args?.[0]).toBe(CHANNEL_ID);
    const since = args?.[1] as number;
    expect(Date.now() - since).toBeGreaterThanOrEqual(7_200_000 - 1000);
  });

  it("omits deleted posts from since reads", async () => {
    const now = Date.now();
    const live = post({ message: "still here", create_at: now });
    // Tombstones come back with a blank body; `state` is only set by some server versions.
    const tombstone = post({ message: "", create_at: now, delete_at: now });
    const flagged = post({ message: "", create_at: now, delete_at: now, state: "DELETED" });
    const client = mockClient({ posts: [live, tombstone, flagged] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", since: "10m" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output.split("\n")).toEqual(["**mmbot** (just now): still here"]);
  });

  it("reads as empty when every post in the window was deleted", async () => {
    const now = Date.now();
    const client = mockClient({ posts: [post({ message: "", create_at: now, delete_at: now })] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", since: "10m" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("(no posts)");
  });

  it("uses getPinnedPosts when pinned", async () => {
    const client = mockClient();
    const { readPosts, calls } = makeTools(client);
    await readPosts({ channel: "my-channel", pinned: true }, toolCtx);
    expect(calls.getPinnedPosts).toEqual([[CHANNEL_ID]]);
    expect(calls.getPosts).toBeUndefined();
  });

  it("uses getPostThread when thread_root_id given (even with since)", async () => {
    const client = mockClient();
    const { readPosts, calls } = makeTools(client);
    await readPosts(
      { channel: "my-channel", thread_root_id: "rrrrrrrrrrrrrrrrrrrrrrrrrr", since: "2h" },
      toolCtx,
    );
    expect(calls.getPostThread).toEqual([["rrrrrrrrrrrrrrrrrrrrrrrrrr"]]);
    expect(calls.getPostsSince).toBeUndefined();
  });

  it("formats posts with username, file metadata and reply threads", async () => {
    const root = post({ message: "root post" });
    const reply = post({ message: "a reply", root_id: root.id });
    const withFile = post({ message: "see attach", file_ids: ["ffffffffffffffffffffffff01"] });
    const client = mockClient({ posts: [root, reply, withFile] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("**mmbot** (");
    expect(output).toContain("root post");
    expect(output).toContain(`↳ **mmbot** (`);
    expect(output).toContain(`(thread ${root.id})`);
    expect(output).toContain(
      "  [file] report.pdf (application/pdf, 4.2 KB, id: ffffffffffffffffffffffff01)",
    );
  });

  it("shows reactions grouped by emoji", async () => {
    const reacted = post({
      message: "reacted post",
      metadata: {
        embeds: [],
        emojis: [],
        files: [],
        images: {},
        reactions: [
          reaction(ME_ID, "thumbsup"),
          reaction("uuuuuuuuuuuuuuuuuuuuuuuuu2", "thumbsup"),
          reaction(ME_ID, "eyes"),
        ],
      },
    });
    const client = mockClient({ posts: [reacted] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("  [reactions] :thumbsup: 2 :eyes: 1");
  });

  it("says nothing about reactions when there are none", async () => {
    const client = mockClient({ posts: [post({ message: "plain" })] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).not.toContain("[reactions]");
  });

  it("caps at 30 posts and points at the oldest shown post for paging", async () => {
    const posts = Array.from({ length: 35 }, (_, i) => post({ message: `m${i}` }));
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`(30 posts shown of 35 — pass before=${posts[5]?.id} for older)`);
    expect(output).toContain("m34");
    expect(output).not.toContain("m0\n");
  });

  it("shows more than 30 posts when limit asks for them", async () => {
    const posts = Array.from({ length: 35 }, (_, i) => post({ message: `m${i}` }));
    const client = mockClient({ posts });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", limit: 50 }, toolCtx);
    expect(calls.getPosts).toEqual([[CHANNEL_ID, 0, 50]]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("m0\n");
    expect(output).not.toContain("posts shown of");
  });

  it("pages backwards with before", async () => {
    const posts = Array.from({ length: 5 }, (_, i) => post({ message: `m${i}` }));
    const pivot = posts[3];
    const client = mockClient({ posts });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", before: pivot?.id }, toolCtx);
    expect(calls.getPostsBefore).toEqual([[CHANNEL_ID, pivot?.id, 0, 30]]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("m2");
    expect(output).not.toContain("m4");
  });

  it("truncates bodies over 500 chars", async () => {
    const long = post({ message: "x".repeat(600) });
    const client = mockClient({ posts: [long] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("**[truncated at 500 chars — pass full=true for the whole message]**");
    expect(output).not.toContain("x".repeat(501));
  });

  it("keeps long bodies intact with full=true", async () => {
    const long = post({ message: "x".repeat(600) });
    const client = mockClient({ posts: [long] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", full: true }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("x".repeat(600));
    expect(output).not.toContain("truncated");
  });

  it("resolves author names in one call for the whole page", async () => {
    const posts = Array.from({ length: 5 }, () => post());
    const client = mockClient({ posts });
    const { readPosts, calls } = makeTools(client);
    await readPosts({ channel: "my-channel" }, toolCtx);
    expect(calls.getProfilesByIds).toEqual([[[ME_ID]]]);
  });
});

describe("mattermost_read_unread", () => {
  it("computes per-channel unread and mentions, marking DMs and first-run channels", async () => {
    const client = mockClient();
    const { readUnread } = makeTools(client);
    const result = await readUnread({}, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("my-channel: 2 unread, 2 mentions");
    expect(output).toContain("alice__mmbot: 2 unread, 0 mentions [DM]");
    expect(output).not.toContain("empty");
    expect(output).toContain("first run: full history unread, consider mark_read bootstrap");
  });

  it("writes a single mention in the singular", async () => {
    const client = mockClient();
    const base = client.getMyChannelMembers;
    client.getMyChannelMembers = async (teamId: string) =>
      (await base.call(client, teamId)).map((m) => ({ ...m, mention_count: 1 }));
    const { readUnread } = makeTools(client);
    const result = await readUnread({}, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("my-channel: 2 unread, 1 mention\n");
    expect(output).not.toContain("1 mentions");
  });

  it("reads unread posts for one channel with unread count and context", async () => {
    const client = mockClient({ posts: [post({ message: "hello" })] });
    const { readUnread, calls } = makeTools(client);
    const result = await readUnread({ channel: "my-channel" }, toolCtx);
    expect(calls.getPostsUnread).toEqual([[CHANNEL_ID, ME_ID, undefined]]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("my-channel: 2 unread");
    expect(output).toContain("hello");
    expect(output).not.toContain("first run");
  });

  it("caps the unread dump at limit", async () => {
    const posts = Array.from({ length: 12 }, (_, i) => post({ message: `u${i}` }));
    const client = mockClient({ posts });
    const { readUnread } = makeTools(client);
    const result = await readUnread({ channel: "my-channel", limit: 3 }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("u11");
    expect(output).not.toContain("u8");
  });

  it("asks only about the one channel, not the whole team", async () => {
    const client = mockClient({ posts: [post({ message: "hello" })] });
    const { readUnread, calls } = makeTools(client);
    await readUnread({ channel: "my-channel" }, toolCtx);
    expect(calls.getChannelMember).toEqual([[CHANNEL_ID, "me"]]);
    expect(calls.getChannel).toEqual([[CHANNEL_ID]]);
    expect(calls.getMyChannelMembers).toBeUndefined();
    expect(calls.getMyChannels).toBeUndefined();
  });

  it("reports no unread for a fully read channel without calling getPostsUnread", async () => {
    const client = mockClient({ posts: [post({ message: "hello" })] });
    const { readUnread, calls } = makeTools(client);
    const result = await readUnread({ channel: "empty" }, toolCtx);
    expect(calls.getPostsUnread).toBeUndefined();
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("No unread messages in empty.");
  });

  it("reports no unread when everything is read", async () => {
    const base = mockClient();
    const client = {
      ...base,
      getMyChannelMembers: async () =>
        [
          { channel_id: CHANNEL_ID, msg_count: 10, mention_count: 0, last_viewed_at: 1 },
        ] as ChannelMembership[],
    } as unknown as Client4 & { state: MockState };
    const ctx = createMattermostContext(config, client);
    const result = await readUnreadTool(ctx).execute({}, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("No unread messages.");
  });
});
