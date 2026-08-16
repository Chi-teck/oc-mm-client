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

  it("throws when edit has no message", async () => {
    const ctx = createMattermostContext(config, mockClient());
    await expect(
      editPostTool(ctx).execute(
        { post_id: "ppppppppppppppppppppppppp1", action: "edit" },
        toolCtx(),
      ),
    ).rejects.toThrow("edit requires a message");
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
    const result = await editPostTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", action: "delete" },
      toolCtx(),
    );
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
