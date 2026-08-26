import { describe, expect, it } from "bun:test";
import {
  type Client4,
  ClientError,
  DEFAULT_LIMIT_AFTER,
  DEFAULT_LIMIT_BEFORE,
} from "@mattermost/client";
import type { ChannelMembership, ServerChannel } from "@mattermost/types/channels";
import type { FileInfo } from "@mattermost/types/files";
import type { PaginatedPostList, Post, PostList } from "@mattermost/types/posts";
import type { Reaction } from "@mattermost/types/reactions";
import type { ToolContext } from "@opencode-ai/plugin";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import { listChannelsTool } from "./channels.js";
import { getPostTool, readPostsTool, readUnreadTool } from "./read.js";

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

// When `MEMBERSHIPS[0]` last saw the channel. Default posts are created after it, so the fixture
// is coherent: the member has read up to here, and everything below is genuinely unread.
const LAST_VIEWED_AT = 1_700_000_500_000;

let seq = 0;
function post(overrides: Partial<Post> = {}): Post {
  seq += 1;
  return {
    id: `ppppppppppppppppppppppp${String(seq).padStart(2, "0")}`,
    create_at: LAST_VIEWED_AT + seq * 1000,
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

function fileInfo(overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id: "ffffffffffffffffffffffff01",
    name: "report.pdf",
    mime_type: "application/pdf",
    size: 4300,
    ...overrides,
  } as FileInfo;
}

/** A root post plus `n` replies, created oldest-first so `create_at` orders them. */
function thread(replies: number): { root: Post; posts: Post[] } {
  const root = post({ message: "root" });
  const rest = Array.from({ length: replies }, (_, i) =>
    post({ message: `r${i}`, root_id: root.id }),
  );
  return { root, posts: [root, ...rest] };
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

// `Client4` fills these in when the caller leaves the argument out (client4.js:26-28, 1277, 1282),
// so the mock has to apply them itself to page the way the real client does.
const PER_PAGE_DEFAULT = 60;
// The server clamps `per_page` no matter what the client asks for: 201, 240 and 1000 all come back
// as 200 items (Mattermost 11.0.4).
const MAX_PER_PAGE = 200;

/** The channel timeline the mock pages over: oldest first, the way `create_at` orders it. */
function timeline(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => a.create_at - b.create_at);
}

/**
 * One page of a channel, the way the server cuts it. `all` is the whole channel oldest-first and
 * `until` the exclusive index of the newest post the query may return — `all.length` for
 * `getPosts`, the pivot's index for `getPostsBefore`. `prev_post_id` names the post just older than
 * the window and `next_post_id` the one just newer, each empty when the window reaches that end.
 */
function channelPage(all: Post[], page: number, perPage: number, until: number): PostList {
  const size = Math.min(perPage, MAX_PER_PAGE);
  const end = Math.max(0, until - page * size);
  const start = Math.max(0, end - size);
  return {
    ...postList(all.slice(start, end)),
    prev_post_id: start > 0 ? (all[start - 1]?.id ?? "") : "",
    next_post_id: end < all.length ? (all[end]?.id ?? "") : "",
  };
}

/**
 * One page of a thread, modelling `direction: "up"` — the only direction this codebase asks for.
 * `perPage` counts replies, the root always comes back on top, and the root reports the true
 * `reply_count`.
 *
 * `has_next` is `perPage <= reply_count`, not `perPage < reply_count`: measured against Mattermost
 * 11.0.4 on a 44-reply thread, `perPage: 44` answered `has_next: true` with all 44 replies present,
 * and only `perPage: 45` answered `false`. So the server flags a *full* page, not a truncated one.
 */
function threadPage(
  posts: Post[],
  rootId: string,
  perPage: number,
  direction: "up" | "down",
): PaginatedPostList {
  const root = posts.find((p) => p.id === rootId);
  if (!root) return { ...postList([]), has_next: false };
  const replies = timeline(posts.filter((p) => p.root_id === rootId));
  const kept =
    direction === "up"
      ? replies.slice(Math.max(0, replies.length - perPage))
      : replies.slice(0, perPage);
  return {
    ...postList([{ ...root, reply_count: replies.length }, ...kept]),
    has_next: replies.length >= perPage,
  };
}

interface MockState {
  calls: Record<string, unknown[]>;
  posts: Post[];
  /** How many of the oldest `posts` this member has already read; the rest are unread. */
  read: number;
}

const MEMBERSHIPS = [
  {
    channel_id: CHANNEL_ID,
    msg_count: 8,
    mention_count: 2,
    last_viewed_at: LAST_VIEWED_AT,
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
  const s: MockState = { calls: {}, posts: [], read: 0, ...state };
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
      const all = timeline(s.posts);
      return channelPage(all, page ?? 0, perPage ?? PER_PAGE_DEFAULT, all.length);
    },
    getPostsSince: async (channelId: string, since: number) => {
      rec("getPostsSince", channelId, since);
      return postList(s.posts.filter((p) => p.create_at > since));
    },
    getPostsBefore: async (channelId: string, postId: string, page?: number, perPage?: number) => {
      rec("getPostsBefore", channelId, postId, page, perPage);
      const all = timeline(s.posts);
      // An unknown pivot leaves the whole channel "before" it, as this mock has always assumed.
      const pivot = all.findIndex((p) => p.id === postId);
      const until = pivot < 0 ? all.length : pivot;
      return channelPage(all, page ?? 0, perPage ?? PER_PAGE_DEFAULT, until);
    },
    getPost: async (postId: string) => {
      rec("getPost", postId);
      const found = s.posts.find((p) => p.id === postId);
      if (!found) {
        throw new ClientError(config.url, {
          message: "Unable to get the post.",
          url: `${config.url}/api/v4/posts/${postId}`,
          status_code: 404,
        });
      }
      return found;
    },
    getPaginatedPostThread: async (
      postId: string,
      options: { perPage?: number; direction?: "up" | "down" } = {},
    ) => {
      rec("getPaginatedPostThread", postId, options);
      const { perPage = PER_PAGE_DEFAULT, direction = "down" } = options;
      return threadPage(s.posts, postId, perPage, direction);
    },
    getPinnedPosts: async (channelId: string) => {
      rec("getPinnedPosts", channelId);
      return postList(s.posts.filter((p) => p.is_pinned));
    },
    getPostsUnread: async (
      channelId: string,
      userId: string,
      limitAfter?: number,
      limitBefore?: number,
    ) => {
      rec("getPostsUnread", channelId, userId, limitAfter, limitBefore);
      const all = timeline(s.posts);
      // The server reads outwards from the member's cursor: `limit_before` already-read posts for
      // context, then `limit_after` unread ones. So `limit_after` keeps the OLDEST unread posts and
      // `next_post_id` names the next one still on the server.
      const start = Math.max(0, s.read - (limitBefore ?? DEFAULT_LIMIT_BEFORE));
      const end = Math.min(all.length, s.read + (limitAfter ?? DEFAULT_LIMIT_AFTER));
      return {
        ...postList(all.slice(start, end)),
        prev_post_id: start > 0 ? (all[start - 1]?.id ?? "") : "",
        next_post_id: end < all.length ? (all[end]?.id ?? "") : "",
      };
    },
    getProfilesByIds: async (userIds: string[]) => {
      rec("getProfilesByIds", userIds);
      return userIds.includes(ME_ID) ? [{ id: ME_ID, username: "mmbot" }] : [];
    },
    state: s,
  } as unknown as Client4 & { state: MockState };
}

function makeTools(client: Client4 & { state: MockState }) {
  const ctx = createMattermostContext(config, client);
  return {
    listChannels: listChannelsTool(ctx).execute,
    readPosts: readPostsTool(ctx).execute,
    getPost: getPostTool(ctx).execute,
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

  it("uses getPaginatedPostThread when thread_root_id given (even with since)", async () => {
    const { root, posts } = thread(0);
    const client = mockClient({ posts });
    const { readPosts, calls } = makeTools(client);
    await readPosts({ channel: "my-channel", thread_root_id: root.id, since: "2h" }, toolCtx);
    expect(calls.getPaginatedPostThread).toEqual([[root.id, { perPage: 30, direction: "up" }]]);
    expect(calls.getPostsSince).toBeUndefined();
  });

  it("keeps the thread root above the newest replies", async () => {
    const { root, posts } = thread(35);
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", thread_root_id: root.id }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(": root");
    expect(output).toContain(": r34");
    expect(output).toContain(": r5");
    expect(output).not.toContain(": r4");
  });

  it("says how many thread replies it left out", async () => {
    const { root, posts } = thread(35);
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", thread_root_id: root.id }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("(newest 30 replies shown of 35 — pass limit=200 for more)");
  });

  // The channel-level `before=` hint is the wrong instrument for a thread: following it reads
  // unrelated channel history. Displaying at `max + 1` keeps the trim from ever firing here.
  it("never offers before= paging on a thread read", async () => {
    const { root, posts } = thread(35);
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", thread_root_id: root.id }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).not.toContain("before=");
  });

  it("adds no note when the whole thread fits", async () => {
    const { root, posts } = thread(8);
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", thread_root_id: root.id }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(": r0");
    expect(output).toContain(": r7");
    expect(output).not.toContain("replies shown");
  });

  // The server sets `has_next` on a *full* page, so a thread with exactly `limit` replies is
  // flagged even though nothing was left out. The note must not then invent an "of M" that would
  // read as "3 of 3 shown, more exist".
  it("claims no total when the server flags a full page it did not truncate", async () => {
    const { root, posts } = thread(3);
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts(
      { channel: "my-channel", thread_root_id: root.id, limit: 3 },
      toolCtx,
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(": root");
    expect(output).toContain(": r0");
    expect(output).toContain("(newest 3 replies shown — pass limit=200 for more)");
    expect(output).not.toContain("of 3");
  });

  it("shows a reply-less thread as just its root", async () => {
    const root = post({ message: "lonely root", create_at: Date.now() });
    const client = mockClient({ posts: [root] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", thread_root_id: root.id }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("**mmbot** (just now): lonely root");
  });

  it("stops offering a higher limit once limit is 200", async () => {
    const { root, posts } = thread(201);
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts(
      { channel: "my-channel", thread_root_id: root.id, limit: 200 },
      toolCtx,
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("(newest 200 replies shown of 201 — older replies are out of reach)");
  });

  it("formats posts with username, file metadata and reply threads", async () => {
    const root = post({ message: "root post" });
    const reply = post({ message: "a reply", root_id: root.id });
    const withFile = post({
      message: "see attach",
      file_ids: ["ffffffffffffffffffffffff01"],
      metadata: { embeds: [], emojis: [], files: [fileInfo()], images: {} },
    });
    const client = mockClient({ posts: [root, reply, withFile] });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("**mmbot** (");
    expect(output).toContain("root post");
    expect(output).toContain(`↳ **mmbot** (`);
    expect(output).toContain(`(thread ${root.id})`);
    expect(output).toContain(
      "  [file] report.pdf (application/pdf, 4.2 KB, id: ffffffffffffffffffffffff01)",
    );
    expect(calls.getFileInfosForPost).toBeUndefined();
  });

  it("takes attachments from post metadata without a per-post file lookup", async () => {
    const withFile = post({
      message: "see attach",
      file_ids: ["ffffffffffffffffffffffff01"],
      metadata: { embeds: [], emojis: [], files: [fileInfo()], images: {} },
    });
    const client = mockClient({ posts: [withFile] });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(
      "  [file] report.pdf (application/pdf, 4.2 KB, id: ffffffffffffffffffffffff01)",
    );
    expect(calls.getFileInfosForPost).toBeUndefined();
  });

  it("flags attachments the server withheld instead of dropping them", async () => {
    const partial = post({
      message: "two files",
      file_ids: ["ffffffffffffffffffffffff01", "ffffffffffffffffffffffff02"],
      metadata: { embeds: [], emojis: [], files: [fileInfo()], images: {} },
    });
    const client = mockClient({ posts: [partial] });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(
      "  [file] report.pdf (application/pdf, 4.2 KB, id: ffffffffffffffffffffffff01)",
    );
    expect(output).toContain("  [file] (1 unavailable — server sent no metadata)");
  });

  it("flags every attachment when the post carries no file metadata", async () => {
    const bare = post({ message: "no metadata", file_ids: ["ffffffffffffffffffffffff01"] });
    const client = mockClient({ posts: [bare] });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("  [file] (1 unavailable — server sent no metadata)");
    expect(output).not.toContain("report.pdf");
    expect(calls.getFileInfosForPost).toBeUndefined();
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

  it("points at the oldest shown post when the server says older posts remain", async () => {
    const posts = Array.from({ length: 35 }, (_, i) => post({ message: `m${i}` }));
    const client = mockClient({ posts });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(calls.getPosts).toEqual([[CHANNEL_ID, 0, 30]]);
    expect(output).toContain(`(30 posts shown — older posts exist, pass before=${posts[5]?.id})`);
    expect(output).toContain("m34");
    expect(output).not.toContain("m0\n");
  });

  it("says nothing about paging when the channel is exhausted", async () => {
    const posts = Array.from({ length: 5 }, (_, i) => post({ message: `m${i}` }));
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("m0");
    expect(output).not.toContain("pass before=");
  });

  it("still offers the next page at the maximum limit", async () => {
    const posts = Array.from({ length: 250 }, (_, i) => post({ message: `m${i}` }));
    const client = mockClient({ posts });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", limit: 200 }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(calls.getPosts).toEqual([[CHANNEL_ID, 0, 200]]);
    expect(output).toContain(`(200 posts shown — older posts exist, pass before=${posts[50]?.id})`);
  });

  it("offers the next page when paging backwards leaves more behind", async () => {
    const posts = Array.from({ length: 40 }, (_, i) => post({ message: `m${i}` }));
    const pivot = posts[39];
    const client = mockClient({ posts });
    const { readPosts } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", before: pivot?.id }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`(30 posts shown — older posts exist, pass before=${posts[9]?.id})`);
  });

  it("shows more than 30 posts when limit asks for them", async () => {
    const posts = Array.from({ length: 35 }, (_, i) => post({ message: `m${i}` }));
    const client = mockClient({ posts });
    const { readPosts, calls } = makeTools(client);
    const result = await readPosts({ channel: "my-channel", limit: 50 }, toolCtx);
    expect(calls.getPosts).toEqual([[CHANNEL_ID, 0, 50]]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("m0\n");
    expect(output).not.toContain("older posts exist");
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

describe("mattermost_get_post", () => {
  it("reads one post by id without paging the channel", async () => {
    const wanted = post({ message: "the one", create_at: Date.now() });
    const client = mockClient({ posts: [post({ message: "noise" }), wanted] });
    const { getPost, calls } = makeTools(client);
    const result = await getPost({ post_id: wanted.id }, toolCtx);
    expect(calls.getPost).toEqual([[wanted.id]]);
    expect(calls.getPosts).toBeUndefined();
    expect(result).toEqual({
      title: "Mattermost: post in my-channel",
      output: "in my-channel:\n**mmbot** (just now): the one",
    });
  });

  it("names the thread root when the post is a reply", async () => {
    const reply = post({ message: "a reply", root_id: "rrrrrrrrrrrrrrrrrrrrrrrrrr" });
    const client = mockClient({ posts: [reply] });
    const { getPost } = makeTools(client);
    const result = await getPost({ post_id: reply.id }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("(thread rrrrrrrrrrrrrrrrrrrrrrrrrr)");
  });

  it("keeps a long body intact with full=true", async () => {
    const long = post({ message: "x".repeat(600) });
    const client = mockClient({ posts: [long] });
    const { getPost } = makeTools(client);
    const result = await getPost({ post_id: long.id, full: true }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("x".repeat(600));
    expect(output).not.toContain("truncated");
  });

  it("explains a 404 instead of relaying the server's message", async () => {
    const client = mockClient();
    const { getPost } = makeTools(client);
    await expect(getPost({ post_id: "ppppppppppppppppppppppppp9" }, toolCtx)).rejects.toThrow(
      "Post ppppppppppppppppppppppppp9 not found — it is deleted, or in a channel this user cannot read.",
    );
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
    expect(calls.getPostsUnread).toStrictEqual([[CHANNEL_ID, ME_ID, 30, 5]]);
    const output = typeof result === "string" ? result : result.output;
    // One post came back; the membership counter claims two. Report the window, note the counter.
    expect(output).toContain("my-channel: 1 unread — all shown");
    expect(output).toContain("(the channel counter says 2)");
    expect(output).toContain("hello");
    expect(output).not.toContain("first run");
  });

  // The cap is the server's now, and `limit_after` reads forward from the read cursor — so the
  // oldest unread posts come back, not the newest.
  it("asks the server for at most limit unread posts and says more remain", async () => {
    const posts = Array.from({ length: 12 }, (_, i) => post({ message: `u${i}` }));
    const client = mockClient({ posts });
    const { readUnread, calls } = makeTools(client);
    const result = await readUnread({ channel: "my-channel", limit: 3 }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(calls.getPostsUnread).toStrictEqual([[CHANNEL_ID, ME_ID, 3, 5]]);
    expect(output).toContain("u0");
    expect(output).not.toContain("u3");
    expect(output).toContain("raise limit (max 200) for the rest");
  });

  it("forwards the limit and the fixed context window", async () => {
    const client = mockClient({ posts: [post({ message: "hello" })] });
    const { readUnread, calls } = makeTools(client);
    await readUnread({ channel: "my-channel", limit: 50 }, toolCtx);
    expect(calls.getPostsUnread).toStrictEqual([[CHANNEL_ID, ME_ID, 50, 5]]);
  });

  it("returns the oldest unread posts and admits the ones left on the server", async () => {
    const posts = Array.from({ length: 40 }, (_, i) => post({ message: `u${i}` }));
    const client = mockClient({ posts });
    const { readUnread } = makeTools(client);
    const result = await readUnread({ channel: "my-channel", limit: 10 }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("showing the oldest 10");
    expect(output).toContain("raise limit (max 200) for the rest");
    expect(output).toContain("u0");
    expect(output).not.toContain("u10");
  });

  // Tripwire for the B2 hint: `prev_post_id` is set here (read history precedes the window), but
  // this tool has no `before` argument, so the hint must stay off.
  it("says all shown, keeps the context window and never emits a paging hint", async () => {
    const posts = Array.from({ length: 12 }, (_, i) => post({ message: `u${i}` }));
    const client = mockClient({ posts, read: 7 });
    const { readUnread } = makeTools(client);
    const result = await readUnread({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("all shown");
    expect(output).toContain("u2");
    expect(output).not.toContain("u1\n");
    expect(output).toContain("u11");
    expect(output).not.toContain("before=");
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

  it("clamps a skewed counter instead of printing a negative unread count", async () => {
    const base = mockClient();
    const client = {
      ...base,
      // 13 read out of a total of 10 — the skew that used to print "-3 unread".
      getMyChannelMembers: async () =>
        [
          { channel_id: CHANNEL_ID, msg_count: 13, mention_count: 2, last_viewed_at: 1 },
        ] as ChannelMembership[],
    } as unknown as Client4 & { state: MockState };
    const ctx = createMattermostContext(config, client);
    const result = await readUnreadTool(ctx).execute({}, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe("my-channel: 0 unread, 2 mentions");
  });

  it("says the counter is stale when the server returns nothing unread", async () => {
    // Every post predates the member's last view, so none of them is actually unread — the
    // counter and the server's own unread window disagree.
    const posts = Array.from({ length: 8 }, (_, i) =>
      post({ message: `old${i}`, create_at: LAST_VIEWED_AT - 10_000 + i }),
    );
    const client = mockClient({ posts, read: posts.length });
    const { readUnread } = makeTools(client);
    const result = await readUnread({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(
      "my-channel: nothing unread on the server — the counter says 2, but every post below is already read",
    );
    expect(output).not.toContain("all shown");
    expect(output).toContain("old7");
  });

  it("still shows one channel's unread mentions when its counter says nothing is unread", async () => {
    const base = mockClient({ posts: [post({ message: "you were mentioned" })] });
    const client = {
      ...base,
      getChannelMember: async () =>
        ({
          channel_id: CHANNEL_ID,
          msg_count: 13,
          mention_count: 2,
          last_viewed_at: 1,
        }) as ChannelMembership,
    } as unknown as Client4 & { state: MockState };
    const ctx = createMattermostContext(config, client);
    const result = await readUnreadTool(ctx).execute({ channel: "my-channel" }, toolCtx);
    const output = typeof result === "string" ? result : result.output;
    // The clamped counter says 0, but the window really does hold an unread post.
    expect(output).toContain("my-channel: 1 unread — all shown");
    expect(output).toContain("(the channel counter says 0)");
    expect(output).toContain("you were mentioned");
  });
});
