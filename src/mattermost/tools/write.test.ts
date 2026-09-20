import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Client4, ClientError } from "@mattermost/client";
import type { ChannelMembership, ServerChannel } from "@mattermost/types/channels";
import type { ClientConfig } from "@mattermost/types/config";
import type { ToolContext } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import {
  createPostTool,
  followThreadTool,
  markReadTool,
  reactTool,
  unfollowThreadTool,
} from "./write.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };
const ME_ID = "uuuuuuuuuuuuuuuuuuuuuuuuu1";
const TEAM_ID = "tttttttttttttttttttttttttt";
const CHANNEL_ID = "ccccccccccccccccccccccccc1";
const ROOT_ID = "rrrrrrrrrrrrrrrrrrrrrrrrr1";
const FILE_ID = "ffffffffffffffffffffffff01";
const SCHEDULED_ID = "sssssssssssssssssssssssss1";
/**
 * Absolute, so the exact `scheduled_at` below can be asserted, but derived from the clock rather
 * than written out: the tool refuses anything past due or more than a year ahead, and a literal
 * date would eventually become one or the other.
 */
const SCHEDULE_AT = Date.now() + 86_400_000;
const SCHEDULE_ISO = new Date(SCHEDULE_AT).toISOString();

/**
 * A file that exists and is not in the worktree, which is what the default upload root is here:
 * `toolCtx` sets `worktree` to the process cwd. A path that merely does not exist would be reported
 * as missing rather than as an escape, so the refusals below need a real one.
 */
let outsideDir: string;
let outside: string;
/** Both sides as the tool sees them — `realpath`ed, since that is what the refusals name. */
let realOutside: string;
let realCwd: string;

beforeAll(async () => {
  outsideDir = await mkdtemp(join(tmpdir(), "oc-mm-upload-"));
  outside = join(outsideDir, "secret.txt");
  await Bun.write(outside, "secret");
  realOutside = await realpath(outside);
  realCwd = await realpath(process.cwd());
});

afterAll(async () => {
  await rm(outsideDir, { recursive: true, force: true });
});

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
  scheduledPosts: unknown[];
  reactions: { user_id: string; emoji_name: string }[];
  membership: ChannelMembership;
  clientConfig: Partial<ClientConfig> | undefined;
  failUploadAt: number | undefined;
  uploadError: unknown;
}

function mockClient(state: Partial<MockState> = {}): Client4 & { state: MockState } {
  const s: MockState = {
    order: [],
    uploads: [],
    createdPosts: [],
    scheduledPosts: [],
    reactions: [{ user_id: ME_ID, emoji_name: "eyes" }],
    membership: {
      channel_id: CHANNEL_ID,
      msg_count: 7,
      mention_count: 2,
      last_viewed_at: 1_700_000_000_000,
    } as ChannelMembership,
    clientConfig: { MaxFileSize: "268435456" },
    failUploadAt: undefined,
    uploadError: new Error("upload failed"),
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
    getClientConfig: async () => {
      rec("getClientConfig");
      if (!s.clientConfig) throw new Error("config unavailable");
      return s.clientConfig as ClientConfig;
    },
    uploadFile: async (form: FormData) => {
      rec("uploadFile");
      if (s.uploads.length === s.failUploadAt) throw s.uploadError;
      s.uploads.push(form);
      return { file_infos: [{ id: FILE_ID }], client_ids: ["c1"] };
    },
    createPost: async (post: unknown) => {
      rec("createPost");
      s.createdPosts.push(post);
      return { id: "newpostttttttttttttttttttttt", message: "x", channel_id: CHANNEL_ID };
    },
    createScheduledPost: async (post: unknown, connectionId: string) => {
      rec(`createScheduledPost(${connectionId})`);
      s.scheduledPosts.push(post);
      // `ClientResponse`, not the post itself — the id the tool reports sits under `.data`.
      return { data: { id: SCHEDULED_ID }, response: undefined, headers: {} };
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
    updateThreadFollowForUser: async (
      userId: string,
      teamId: string,
      threadId: string,
      state: boolean,
    ) => {
      rec("updateThreadFollowForUser");
      s.order.push(`${userId}:${teamId}:${threadId}:${state}`);
      return { status: "ok" };
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

  it("schedules instead of posting when schedule_at is set", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    const result = await createPostTool(ctx).execute(
      { channel: "my-channel", message: "later", schedule_at: SCHEDULE_ISO },
      tctx,
    );
    // The connection id only suppresses the caller's own WebSocket echo, and this client has none.
    expect(client.state.order).toEqual(["createScheduledPost()"]);
    expect(client.state.scheduledPosts[0]).toEqual({
      channel_id: CHANNEL_ID,
      message: "later",
      scheduled_at: SCHEDULE_AT,
    });
    const local = new Date(SCHEDULE_AT).toLocaleString(undefined, { timeZoneName: "short" });
    // The zone has to be in there, whatever this machine's zone happens to be: pinning one would
    // fail on every other developer's box, while a bare `toLocaleString` here would let the zone
    // be dropped again without a test noticing.
    expect(local).not.toBe(new Date(SCHEDULE_AT).toLocaleString());
    expect((asks[0] as { patterns: string[] }).patterns[0]).toContain(`[send at ${local}]`);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe(
      `Scheduled for ${local} in my-channel (scheduled post id: ${SCHEDULED_ID})`,
    );
  });

  it("keeps root_id when a thread reply is scheduled", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await createPostTool(ctx).execute(
      {
        channel: "my-channel",
        message: "later reply",
        thread_root_id: "rrrrrrrrrrrrrrrrrrrrrrrrrr",
        schedule_at: SCHEDULE_ISO,
      },
      recordingCtx().tctx,
    );
    expect(client.state.scheduledPosts[0]).toEqual({
      channel_id: CHANNEL_ID,
      message: "later reply",
      root_id: "rrrrrrrrrrrrrrrrrrrrrrrrrr",
      scheduled_at: SCHEDULE_AT,
    });
  });

  it("uploads attachments for a scheduled post too", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await createPostTool(ctx).execute(
      {
        channel: "my-channel",
        message: "later with file",
        schedule_at: SCHEDULE_ISO,
        attachments: ["attach.txt"],
      },
      recordingCtx().tctx,
    );
    expect(client.state.order).toEqual(["getClientConfig", "uploadFile", "createScheduledPost()"]);
    expect(client.state.scheduledPosts[0]).toEqual({
      channel_id: CHANNEL_ID,
      message: "later with file",
      file_ids: [FILE_ID],
      scheduled_at: SCHEDULE_AT,
    });
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`scheduled post id: ${SCHEDULED_ID}, 1 file(s)`);
  });

  it("refuses a past schedule_at before asking or uploading", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await expect(
      createPostTool(ctx).execute(
        {
          channel: "my-channel",
          message: "too late",
          schedule_at: "2020-01-01T10:00:00Z",
          attachments: ["attach.txt"],
        },
        tctx,
      ),
    ).rejects.toThrow("Cannot schedule in the past: 2020-01-01T10:00:00Z resolved to 2020-01-01");
    expect(asks).toEqual([]);
    expect(client.state.order).toEqual([]);
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

  it("refuses an attachment outside the root, before asking or uploading", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: [outside] },
        tctx,
      ),
    ).rejects.toThrow(
      `Attachment outside ${realCwd}: ${outside} (resolved to ${realOutside}) — set the uploadRoot plugin option to allow it`,
    );
    // Refused ahead of the prompt, not merely ahead of the upload: a path that was never going to
    // be allowed should not cost a human a decision.
    expect(asks).toEqual([]);
    expect(client.state.order).toEqual([]);
  });

  it("refuses a symlink inside the root that points outside it", async () => {
    // The case a lexical prefix check passes: the path is under the worktree, the file is not.
    const link = "local/tmp/link.txt";
    await rm(link, { force: true });
    await symlink(outside, link);
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    try {
      await expect(
        createPostTool(ctx).execute(
          { channel: "my-channel", message: "x", attachments: ["link.txt"] },
          tctx,
        ),
      ).rejects.toThrow(`Attachment outside ${realCwd}: link.txt (resolved to ${realOutside})`);
      expect(asks).toEqual([]);
      expect(client.state.order).toEqual([]);
    } finally {
      await rm(link, { force: true });
    }
  });

  it("refuses the root itself, which was never a file", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client, { uploadRoot: resolve("local/tmp") });
    const { asks, tctx } = recordingCtx();
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: ["."] },
        tctx,
      ),
    ).rejects.toThrow(`Attachment is ${await realpath("local/tmp")} itself, not a file: .`);
    expect(asks).toEqual([]);
  });

  it("still reports a missing attachment as missing, not as an escape", async () => {
    // Outside the root and absent at once: the containment check cannot resolve it, and saying
    // "outside the root" about a typo sends the reader to the config instead of to the filename.
    const gone = join(outsideDir, "gone.txt");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: [gone] },
        recordingCtx().tctx,
      ),
    ).rejects.toThrow(`Attachment not found: ${gone}`);
  });

  it("honours an uploadRoot, still resolving attachments against the tool call's directory", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    // Two anchors, not one: the root is `local`, the tool call's directory is `local/tmp`, and
    // `attach.txt` means the file in the latter — re-anchoring it on the root would move it.
    const ctx = createMattermostContext(config, client, { uploadRoot: resolve("local") });
    const { asks, tctx } = recordingCtx();
    await createPostTool(ctx).execute(
      { channel: "my-channel", message: "with file", attachments: ["attach.txt"] },
      tctx,
    );
    const ask = asks[0] as { patterns: string[] };
    expect(ask.patterns[0]).toContain(`[files: ${resolve("local/tmp", "attach.txt")}]`);
    expect(client.state.order).toContain("uploadFile");
  });

  it("uploads nothing when a later attachment is outside the root", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: ["attach.txt", outside] },
        tctx,
      ),
    ).rejects.toThrow("Attachment outside ");
    expect(asks).toEqual([]);
    expect(client.state.order).toEqual([]);
  });

  it("refuses an attachment over the server's MaxFileSize before uploading anything", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient({ clientConfig: { MaxFileSize: "8" } });
    const ctx = createMattermostContext(config, client);
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: ["attach.txt"] },
        recordingCtx().tctx,
      ),
    ).rejects.toThrow("Attachment too large: attach.txt is 16 B, over the server limit of 8 B");
    expect(client.state.order).toEqual(["getClientConfig"]);
  });

  it("uploads anyway when the server config cannot be read", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient({ clientConfig: undefined });
    const ctx = createMattermostContext(config, client);
    await createPostTool(ctx).execute(
      { channel: "my-channel", message: "x", attachments: ["attach.txt"] },
      recordingCtx().tctx,
    );
    expect(client.state.order).toEqual(["getClientConfig", "uploadFile", "createPost"]);
  });

  it("names the orphaned file ids when a later upload fails", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    await Bun.write("local/tmp/attach2.txt", "second attachment");
    const client = mockClient({
      failUploadAt: 1,
      uploadError: new ClientError(config.url, {
        message: "The file(s) are too large to be uploaded.",
        url: `${config.url}/api/v4/files`,
        status_code: 413,
      }),
    });
    const ctx = createMattermostContext(config, client);
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: ["attach.txt", "attach2.txt"] },
        recordingCtx().tctx,
      ),
    ).rejects.toThrow(
      `Uploaded 1 file(s), then attach2.txt failed — file ids ${FILE_ID} are orphaned on the server and cannot be deleted (Mattermost only deletes a file with the post that carries it). Cause: Mattermost API 413 /api/v4/files: The file(s) are too large to be uploaded.`,
    );
    expect(client.state.order).not.toContain("createPost");
  });

  it("rethrows a first-upload failure untouched, since nothing is orphaned", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const failure = new Error("network reset");
    const client = mockClient({ failUploadAt: 0, uploadError: failure });
    const ctx = createMattermostContext(config, client);
    await expect(
      createPostTool(ctx).execute(
        { channel: "my-channel", message: "x", attachments: ["attach.txt"] },
        recordingCtx().tctx,
      ),
    ).rejects.toBe(failure);
  });

  it("fetches the server config once across posts", async () => {
    await Bun.write("local/tmp/attach.txt", "hello attachment");
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const post = createPostTool(ctx);
    const args = { channel: "my-channel", message: "twice", attachments: ["attach.txt"] };
    await post.execute(args, recordingCtx().tctx);
    await post.execute(args, recordingCtx().tctx);
    expect(client.state.order.filter((call) => call === "getClientConfig")).toHaveLength(1);
    expect(client.state.order.filter((call) => call === "uploadFile")).toHaveLength(2);
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

  it("asks first, then reports nothing to remove instead of a false success", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    const result = await reactTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", emoji: "heart", action: "remove" },
      tctx,
    );
    expect(asks).toHaveLength(1);
    expect((asks[0] as { permission: string }).permission).toBe("mattermost_react");
    expect(client.state.order).toEqual(["getReactionsForPost"]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe(
      "No :heart: reaction by you on post ppppppppppppppppppppppppp1 — nothing to remove.",
    );
  });

  it("does not remove another user's reaction of the same emoji", async () => {
    const client = mockClient({ reactions: [{ user_id: "someone-else", emoji_name: "eyes" }] });
    const ctx = createMattermostContext(config, client);
    const { asks, tctx } = recordingCtx();
    await reactTool(ctx).execute(
      { post_id: "ppppppppppppppppppppppppp1", emoji: "eyes", action: "remove" },
      tctx,
    );
    expect(asks).toHaveLength(1);
    expect(client.state.order).toEqual(["getReactionsForPost"]);
  });
});

describe("mattermost_follow_thread", () => {
  it("follows with the bot's own id and the configured team", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await followThreadTool(ctx).execute({ thread_root_id: ROOT_ID }, toolCtx());
    // The team is the assertion that matters: it comes from config, never from the post.
    expect(client.state.order).toEqual([
      "updateThreadFollowForUser",
      `${ME_ID}:${TEAM_ID}:${ROOT_ID}:true`,
    ]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe(`Following thread ${ROOT_ID}`);
  });

  it("unfollows with state false", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const result = await unfollowThreadTool(ctx).execute({ thread_root_id: ROOT_ID }, toolCtx());
    expect(client.state.order).toEqual([
      "updateThreadFollowForUser",
      `${ME_ID}:${TEAM_ID}:${ROOT_ID}:false`,
    ]);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toBe(`Left thread ${ROOT_ID} — posting in it again re-follows it.`);
  });

  it("neither asks", async () => {
    // Deliberate, not an oversight: following changes only the bot's own subscriptions, and the
    // exit gesture has to work in a host that auto-rejects prompts. This test fails the moment a
    // `confirmWrite` is added to either tool.
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await followThreadTool(ctx).execute({ thread_root_id: ROOT_ID }, rejectingCtx());
    await unfollowThreadTool(ctx).execute({ thread_root_id: ROOT_ID }, rejectingCtx());
    expect(client.state.order).toEqual([
      "updateThreadFollowForUser",
      `${ME_ID}:${TEAM_ID}:${ROOT_ID}:true`,
      "updateThreadFollowForUser",
      `${ME_ID}:${TEAM_ID}:${ROOT_ID}:false`,
    ]);
  });

  it("requires a thread_root_id (zod)", () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    for (const args of [followThreadTool(ctx).args, unfollowThreadTool(ctx).args]) {
      expect(tool.schema.object(args).safeParse({}).success).toBe(false);
    }
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

  it("react performs no API calls when the ask is rejected, including on remove", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await expect(
      reactTool(ctx).execute(
        { post_id: "ppppppppppppppppppppppppp1", emoji: "heart", action: "remove" },
        rejectingCtx(),
      ),
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
