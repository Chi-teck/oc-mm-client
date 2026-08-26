import { describe, expect, it } from "bun:test";
import { type Client4, ClientError } from "@mattermost/client";
import type { ServerChannel } from "@mattermost/types/channels";
import type { Post } from "@mattermost/types/posts";
import type { ToolContext } from "@opencode-ai/plugin";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import { dmTool, editPostTool, listMembersTool, searchTool } from "./misc.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };
const ME_ID = "uuuuuuuuuuuuuuuuuuuuuuuuu1";
const ALICE_ID = "uuuuuuuuuuuuuuuuuuuuuuuuu2";
const TEAM_ID = "tttttttttttttttttttttttttt";
const CHANNEL_ID = "ccccccccccccccccccccccccc1";

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

const post = (id: string, message: string, overrides: Partial<Post> = {}): Post =>
  ({
    id,
    create_at: Date.now() - 3_600_000,
    update_at: 0,
    edit_at: 0,
    delete_at: 0,
    is_pinned: false,
    user_id: ALICE_ID,
    channel_id: CHANNEL_ID,
    root_id: "",
    original_id: "",
    message,
    type: "",
    props: {},
    hashtags: "",
    pending_post_id: "",
    reply_count: 0,
    metadata: { embeds: [], emojis: [], files: [], images: {} },
    ...overrides,
  }) as Post;

interface MockState {
  calls: Record<string, unknown[][]>;
}

function mockClient(state: Partial<MockState> = {}): Client4 & { state: MockState } {
  const s: MockState = { calls: {}, ...state };
  const rec = (name: string, ...args: unknown[]) => {
    if (!s.calls[name]) s.calls[name] = [];
    s.calls[name].push(args);
  };
  const channel = (id = CHANNEL_ID, name = "my-channel"): ServerChannel =>
    ({ id, name, display_name: name, type: "P" }) as ServerChannel;
  return {
    getMe: async () => ({ id: ME_ID, username: "mmbot" }),
    getTeamByName: async (name: string) => ({ id: TEAM_ID, name }),
    getChannelByName: async (teamId: string, name: string) => {
      rec("getChannelByName", teamId, name);
      if (name === "my-channel") return channel();
      throw new Error("not found");
    },
    getChannel: async (id: string) => {
      rec("getChannel", id);
      return channel(id, id === CHANNEL_ID ? "my-channel" : id);
    },
    getPost: async (postId: string) => {
      rec("getPost", postId);
      return post(postId, "old body");
    },
    getProfilesInChannel: async (channelId: string, page?: number, perPage?: number) => {
      rec("getProfilesInChannel", channelId, page, perPage);
      return [
        { id: ALICE_ID, username: "alice", first_name: "Alice", last_name: "Anderson" },
        { id: ME_ID, username: "mmbot" },
      ];
    },
    getProfilesByIds: async (userIds: string[]) => {
      rec("getProfilesByIds", userIds);
      return userIds
        .map((id) => (id === ALICE_ID ? { id, username: "alice" } : { id, username: "mmbot" }))
        .filter((profile) => profile.id === ALICE_ID || profile.id === ME_ID);
    },
    autocompleteUsers: async (name: string, teamId: string, channelId: string) => {
      rec("autocompleteUsers", name, teamId, channelId);
      return {
        users: [{ id: ALICE_ID, username: "alice", first_name: "Alice", last_name: "Anderson" }],
        out_of_channel: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", username: "alicia" }],
      };
    },
    patchPost: async (patch: unknown) => {
      rec("patchPost", patch);
      return { id: "ppppppppppppppppppppppppp1" };
    },
    deletePost: async (postId: string) => {
      rec("deletePost", postId);
      return { status: "ok" };
    },
    searchPosts: async (teamId: string, terms: string, isOr: boolean) => {
      rec("searchPosts", teamId, terms, isOr);
      const posts = [post("ppppppppppppppppppppppppp1", "deploy failed")];
      return {
        order: posts.map((p) => p.id),
        posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        next_post_id: "",
        prev_post_id: "",
        first_inaccessible_post_time: 0,
        matches: {},
      };
    },
    searchFiles: async (teamId: string, terms: string, isOr: boolean) => {
      rec("searchFiles", teamId, terms, isOr);
      const items =
        terms === "zzz"
          ? []
          : [
              {
                id: "ffffffffffffffffffffffff01",
                name: "report.csv",
                mime_type: "text/csv",
                size: 4300,
                channel_id: CHANNEL_ID,
              },
              {
                id: "ffffffffffffffffffffffff02",
                name: "notes.txt",
                mime_type: "text/plain",
                size: 120,
                channel_id: CHANNEL_ID,
              },
            ];
      return {
        order: items.map((i) => i.id).reverse(),
        file_infos: Object.fromEntries(items.map((i) => [i.id, i])),
      };
    },
    getUserByUsername: async (username: string) => {
      rec("getUserByUsername", username);
      if (username === "alice") return { id: ALICE_ID, username };
      throw new Error("not found");
    },
    createDirectChannel: async (userIds: string[]) => {
      rec("createDirectChannel", userIds);
      return channel(`dm${userIds.sort().join("")}`, "dm");
    },
    state: s,
  } as unknown as Client4 & { state: MockState };
}

describe("mattermost_edit_post", () => {
  it("patches with new message", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "edit", message: "fixed" },
      toolCtx(),
    );
    expect(client.state.calls.patchPost).toEqual([
      [{ id: "ppppppppppppppppppppppppp1", message: "fixed" }],
    ]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("Edited post ppppppppppppppppppppppppp1");
  });

  it("throws when edit has no message, before asking or reading the post", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await expect(
      editPostTool(ctx).execute({ post_id: "ppppppppppppppppppppppppp1", action: "edit" }, tctx),
    ).rejects.toThrow("edit requires a message");
    expect(asks).toEqual([]);
    expect(client.state.calls.getPost).toBeUndefined();
  });

  it("deletes", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "delete" },
      toolCtx(),
    );
    expect(client.state.calls.deletePost).toEqual([["ppppppppppppppppppppppppp1"]]);
  });
  it("reports a post that is already gone instead of the server's error", async () => {
    const client = mockClient();
    client.deletePost = async () => {
      throw new ClientError(config.url, {
        message: "Не удалось получить сообщение",
        server_error_id: "app.post.get.app_error",
        status_code: 404,
      });
    };
    const ctx = createMattermostContext(config, client);
    const asks: unknown[] = [];
    const result = await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "delete" },
      toolCtx(async (input) => void asks.push(input)),
    );
    expect(asks).toHaveLength(1);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe(
      "Post ppppppppppppppppppppppppp1 is already deleted or does not exist — nothing to do.",
    );
  });

  it("propagates delete failures other than a missing post", async () => {
    const client = mockClient();
    client.deletePost = async () => {
      throw new ClientError(config.url, {
        message: "You do not have the appropriate permissions",
        server_error_id: "api.context.permissions.app_error",
        status_code: 403,
      });
    };
    const ctx = createMattermostContext(config, client);
    await expect(
      editPostTool(ctx).execute(
        { post_id: "ppppppppppppppppppppppppp1", action: "delete" },
        toolCtx(),
      ),
    ).rejects.toThrow("You do not have the appropriate permissions");
  });

  it("edit_post and dm ask before executing; search and list_members do not", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const asks: unknown[] = [];
    const approve = toolCtx(async (input) => void asks.push(input));
    await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "edit", message: "x" },
      approve,
    );
    await dmTool(ctx).execute({ username: "alice" }, approve);
    expect(asks).toHaveLength(2);
    expect((asks[0] as { permission: string }).permission).toBe("mattermost_edit_post");
    expect((asks[1] as { permission: string }).permission).toBe("mattermost_dm");
    const rejecting = toolCtx(async () => {
      throw new Error("The user rejected permission to use this specific tool call.");
    });
    await searchTool(ctx).execute({ query: "deploy", type: "posts" }, rejecting);
    await listMembersTool(ctx).execute({ channel: "my-channel" }, rejecting);
  });

  it("edit_post and dm perform no API calls when the ask is rejected", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const rejecting = toolCtx(async () => {
      throw new Error("The user rejected permission to use this specific tool call.");
    });
    await expect(
      editPostTool(ctx).execute(
        { post_id: "ppppppppppppppppppppppppp1", action: "delete" },
        rejecting,
      ),
    ).rejects.toThrow("rejected permission");
    await expect(dmTool(ctx).execute({ username: "alice" }, rejecting)).rejects.toThrow(
      "rejected permission",
    );
    // `edit_post` reads the post and its channel before asking, so the prompt can name what is
    // about to be rewritten — a prompt-rendering lookup, which the gate invariant allows. What a
    // denial must prevent is every call that changes something.
    expect(Object.keys(client.state.calls).sort()).toEqual(["getChannel", "getPost"]);
    for (const write of ["patchPost", "deletePost", "createDirectChannel", "getUserByUsername"]) {
      expect(client.state.calls[write]).toBeUndefined();
    }
  });

  it("names the channel, the current body and the replacement in the prompt", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "edit", message: "fixed" },
      tctx,
    );
    expect((asks[0] as { patterns: string[] }).patterns[0]).toBe(
      "mattermost_edit_post edit ppppppppppppppppppppppppp1 in my-channel: old body → fixed",
    );
  });

  it("names the body a delete destroys", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "delete" },
      tctx,
    );
    expect((asks[0] as { patterns: string[] }).patterns[0]).toBe(
      "mattermost_edit_post delete ppppppppppppppppppppppppp1 in my-channel: old body",
    );
  });

  it("flattens a multi-line body onto one prompt line", async () => {
    const client = mockClient();
    client.getPost = async (postId: string) => post(postId, "Release notes:\n\n- one\n- two");
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "edit", message: "next" },
      tctx,
    );
    const summary = (asks[0] as { patterns: string[] }).patterns[0] ?? "";
    expect(summary).not.toContain("\n");
    expect(summary).toBe(
      "mattermost_edit_post edit ppppppppppppppppppppppppp1 in my-channel: " +
        "Release notes: - one - two → next",
    );
  });

  it("cuts each body at 120 chars", async () => {
    const client = mockClient();
    client.getPost = async (postId: string) => post(postId, "x".repeat(300));
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "edit", message: "y".repeat(300) },
      tctx,
    );
    const summary = (asks[0] as { patterns: string[] }).patterns[0] ?? "";
    expect(summary).toContain("x".repeat(120));
    expect(summary).not.toContain("x".repeat(121));
    expect(summary).toContain("y".repeat(120));
    expect(summary).not.toContain("y".repeat(121));
  });

  it("reads the post but writes nothing when the ask is rejected", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const rejecting = toolCtx(async () => {
      throw new Error("The user rejected permission to use this specific tool call.");
    });
    await expect(
      editPostTool(ctx).execute(
        { post_id: "ppppppppppppppppppppppppp1", action: "edit", message: "nope" },
        rejecting,
      ),
    ).rejects.toThrow("rejected permission");
    // The preview read is deliberate: mattermost_get_post makes it with no prompt at all.
    expect(client.state.calls.getPost).toEqual([["ppppppppppppppppppppppppp1"]]);
    expect(client.state.calls.patchPost).toBeUndefined();
    expect(client.state.calls.deletePost).toBeUndefined();
  });

  it("falls back to the bare summary when the post cannot be read", async () => {
    const client = mockClient();
    const gone = () => {
      throw new ClientError(config.url, {
        message: "Unable to get the post.",
        server_error_id: "app.post.get.app_error",
        status_code: 404,
      });
    };
    client.getPost = async () => gone();
    client.deletePost = async () => gone();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    const result = await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "delete" },
      tctx,
    );
    expect((asks[0] as { patterns: string[] }).patterns[0]).toBe(
      "mattermost_edit_post delete ppppppppppppppppppppppppp1",
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe(
      "Post ppppppppppppppppppppppppp1 is already deleted or does not exist — nothing to do.",
    );
  });
});

describe("mattermost_search", () => {
  it("returns post hits with username, channel, rel time and post id", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await searchTool(ctx).execute({ query: "deploy", type: "posts" }, toolCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("**alice** (1h ago) in my-channel: deploy failed");
    expect(output).toContain("(post ppppppppppppppppppppppppp1)");
  });

  it("returns file hits with channel and metadata", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await searchTool(ctx).execute({ query: "report", type: "files" }, toolCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(
      "[file] report.csv (text/csv, 4.2 KB, id: ffffffffffffffffffffffff01) [my-channel]",
    );
  });

  it("keeps the server's relevance order instead of the file_infos key order", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await searchTool(ctx).execute({ query: "report", type: "files" }, toolCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output.indexOf("notes.txt")).toBeLessThan(output.indexOf("report.csv"));
  });

  it("truncates long hit bodies like the read path", async () => {
    const base = mockClient();
    const long = "y".repeat(600);
    const client = {
      ...base,
      searchPosts: async () => {
        const hit = {
          id: "ppppppppppppppppppppppppp2",
          create_at: Date.now(),
          user_id: ALICE_ID,
          channel_id: CHANNEL_ID,
          root_id: "",
          message: long,
        } as Post;
        return {
          order: [hit.id],
          posts: { [hit.id]: hit },
          next_post_id: "",
          prev_post_id: "",
          first_inaccessible_post_time: 0,
          matches: {},
        };
      },
    } as unknown as Client4 & { state: MockState };
    const ctx = createMattermostContext(config, client);
    const result = await searchTool(ctx).execute({ query: "y", type: "posts" }, toolCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(
      "**[truncated at 500 chars — read it with mattermost_read_posts full=true]**",
    );
    expect(output).not.toContain("y".repeat(501));
  });

  it("reports no hits politely", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await searchTool(ctx).execute({ query: "zzz", type: "files" }, toolCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain('No files found for "zzz".');
  });
});

describe("mattermost_list_members", () => {
  // A server with `total` members: offset is page * per_page, and past the end it returns [].
  const memberServer = (total: number) => {
    const asked: number[][] = [];
    const client = {
      ...mockClient(),
      getProfilesInChannel: async (_channelId: string, page: number, perPage: number) => {
        asked.push([page, perPage]);
        const offset = page * perPage;
        const size = Math.max(0, Math.min(perPage, total - offset));
        return Array.from({ length: size }, (_, i) => ({
          id: `u${offset + i}`,
          username: `user${offset + i}`,
        }));
      },
    } as unknown as Client4 & { state: MockState };
    return { client, asked };
  };

  it("lists channel profiles", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await listMembersTool(ctx).execute({ channel: "my-channel" }, toolCtx());
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("- alice — Alice Anderson");
    expect(output).toContain("- mmbot");
    expect(client.state.calls.getProfilesInChannel).toEqual([[CHANNEL_ID, 0, 200]]);
  });

  it("pages past the 200-profile limit and counts every member", async () => {
    const base = mockClient();
    const pages = [
      Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, username: `user${i}` })),
      Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, username: `late${i}` })),
    ];
    const asked: number[] = [];
    const client = {
      ...base,
      getProfilesInChannel: async (_channelId: string, page: number) => {
        asked.push(page);
        return pages[page] ?? [];
      },
    } as unknown as Client4 & { state: MockState };
    const ctx = createMattermostContext(config, client);
    const result = await listMembersTool(ctx).execute({ channel: "my-channel" }, toolCtx());
    expect(asked).toEqual([0, 1]);
    const title = typeof result === "string" ? "" : result.title;
    expect(title).toBe("Mattermost: 205 members of my-channel");
  });

  it("reports exactly 1000 members as complete, not truncated", async () => {
    const { client, asked } = memberServer(1000);
    const ctx = createMattermostContext(config, client);
    const result = await listMembersTool(ctx).execute({ channel: "my-channel" }, toolCtx());
    // The sixth request is the probe page that proves nothing follows.
    expect(asked).toEqual([
      [0, 200],
      [1, 200],
      [2, 200],
      [3, 200],
      [4, 200],
      [5, 200],
    ]);
    const title = typeof result === "string" ? "" : result.title;
    expect(title).toBe("Mattermost: 1000 members of my-channel");
    const output = typeof result === "string" ? result : result.output;
    expect(output.split("\n")).toHaveLength(1000);
    expect(output).not.toContain("pass query to search");
  });

  it("reports more than 1000 members as truncated and drops the overflow page", async () => {
    const { client, asked } = memberServer(1001);
    const ctx = createMattermostContext(config, client);
    const result = await listMembersTool(ctx).execute({ channel: "my-channel" }, toolCtx());
    expect(asked).toHaveLength(6);
    const title = typeof result === "string" ? "" : result.title;
    expect(title).toBe("Mattermost: first 1000 members of my-channel");
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("- user999");
    expect(output).not.toContain("- user1000");
    expect(output.split("\n").at(-1)).toBe("(first 1000 members — pass query to search)");
  });

  it("autocomplete splits in-channel vs out-of-channel with warning", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await listMembersTool(ctx).execute(
      { channel: "my-channel", query: "ali" },
      toolCtx(),
    );
    expect(client.state.calls.autocompleteUsers).toEqual([["ali", TEAM_ID, CHANNEL_ID]]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("- alice — Alice Anderson");
    expect(output).toContain("- alicia [NOT in channel — mentions won't notify]");
  });
});

describe("mattermost_dm", () => {
  it("creates DM with single array arg [me.id, uid] and returns channel name", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await dmTool(ctx).execute({ username: "alice" }, toolCtx());
    expect(client.state.calls.getUserByUsername).toEqual([["alice"]]);
    expect(client.state.calls.createDirectChannel).toEqual([[[ME_ID, ALICE_ID]]]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(
      `DM channel with @alice: dm (id: dm${[ME_ID, ALICE_ID].sort().join("")})`,
    );
    expect(output).toContain("pass it as the channel to mattermost_create_post");
  });

  it("throws on unknown username", async () => {
    const ctx = createMattermostContext(config, mockClient());
    await expect(dmTool(ctx).execute({ username: "nobody" }, toolCtx())).rejects.toThrow(
      "not found",
    );
  });
});
