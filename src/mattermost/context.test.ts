import { describe, expect, it } from "bun:test";
import { type Client4, ClientError } from "@mattermost/client";
import type { ServerChannel } from "@mattermost/types/channels";
import type { ServerError } from "@mattermost/types/errors";
import {
  createMattermostContext,
  parseSchedule,
  parseSince,
  unreadCount,
  withTimeout,
} from "./context.js";
import type { MattermostEnv } from "./env.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };

const channel = (overrides: Partial<ServerChannel> = {}): ServerChannel =>
  ({
    id: "ccccccccccccccccccccccccc1",
    name: "my-channel",
    display_name: "MM Test",
    type: "O",
    ...overrides,
  }) as ServerChannel;

function teamError(data: Partial<ServerError> = {}): ClientError {
  return new ClientError(config.url, {
    message: "Unable to find the existing team.",
    url: `${config.url}/api/v4/teams/name/nope`,
    status_code: 404,
    ...data,
  });
}

function mockClient(overrides: Record<string, unknown> = {}): Client4 & { calls: string[][] } {
  const calls: string[][] = [];
  const base: Record<string, unknown> = {
    getMe: async () => {
      calls.push(["getMe"]);
      return { id: "xxxxxxxxxxxxxxxxxxxxxxxxxx", username: "mmbot" };
    },
    getTeamByName: async (name: string) => {
      calls.push(["getTeamByName", name]);
      if (name === "my-team") return { id: "tttttttttttttttttttttttttt", name };
      throw teamError();
    },
    getChannel: async (id: string) => {
      calls.push(["getChannel", id]);
      if (id === "ccccccccccccccccccccccccc1") return channel();
      throw new Error("not found");
    },
    getChannelByName: async (teamId: string, name: string) => {
      calls.push(["getChannelByName", teamId, name]);
      if (name === "my-channel") return channel();
      throw new Error("not found");
    },
    getMyChannels: async () => {
      calls.push(["getMyChannels"]);
      return [
        channel(),
        channel({
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
          name: "town-square",
          display_name: "Town Square",
        }),
        channel({ id: "cccccccccccccccccccccccccc", name: "mm-sandbox", display_name: "Sandbox" }),
      ];
    },
    ...overrides,
  };
  return { ...base, calls } as unknown as Client4 & { calls: string[][] };
}

describe("parseSince", () => {
  const now = 1_800_000_000_000;

  it("parses relative offsets", () => {
    expect(parseSince("2h", now)).toBe(now - 7_200_000);
    expect(parseSince("30m", now)).toBe(now - 1_800_000);
    expect(parseSince("45s", now)).toBe(now - 45_000);
    expect(parseSince("3d", now)).toBe(now - 259_200_000);
  });

  it("parses epoch ms and ISO dates", () => {
    expect(parseSince("1799999999999", now)).toBe(1_799_999_999_999);
    expect(parseSince("2026-08-16T10:00:00Z", now)).toBe(Date.parse("2026-08-16T10:00:00Z"));
  });

  it("throws on garbage", () => {
    expect(() => parseSince("soon", now)).toThrow("Invalid since");
    expect(() => parseSince("", now)).toThrow("Invalid since");
  });
});

describe("parseSchedule", () => {
  const now = 1_800_000_000_000;

  // Exact values, not ranges: milliseconds is the wire unit, and a seconds/ms slip would schedule
  // for the year 57000 with nothing else in the tool to catch it.
  it("adds relative offsets to now", () => {
    expect(parseSchedule("2h", now)).toBe(now + 7_200_000);
    expect(parseSchedule("30m", now)).toBe(now + 1_800_000);
    expect(parseSchedule("45s", now)).toBe(now + 45_000);
    expect(parseSchedule("3d", now)).toBe(now + 259_200_000);
  });

  it("takes epoch ms and ISO dates as absolute", () => {
    expect(parseSchedule("1800000000001", now)).toBe(1_800_000_000_001);
    expect(parseSchedule("2027-06-01T10:00:00Z", now)).toBe(Date.parse("2027-06-01T10:00:00Z"));
  });

  it("refuses a time that is not in the future, naming what was parsed", () => {
    expect(() => parseSchedule("2026-08-16T10:00:00Z", now)).toThrow(
      "Cannot schedule in the past: 2026-08-16T10:00:00Z resolved to 2026-08-16",
    );
    expect(() => parseSchedule("1799999999999", now)).toThrow("Cannot schedule in the past");
    // The boundary: `now` itself is already too late, and so is a zero offset.
    expect(() => parseSchedule(String(now), now)).toThrow("Cannot schedule in the past");
    expect(() => parseSchedule("0m", now)).toThrow("Cannot schedule in the past");
  });

  it("refuses a time too far ahead to be a schedule", () => {
    // Epoch microseconds: in the future by every other check, and the year 59009 by this one.
    expect(() => parseSchedule("1800000000000000", now)).toThrow(
      "Cannot schedule more than 365 days out: 1800000000000000 resolved to epoch ms 1800000000000000",
    );
    // Nanoseconds are past what `Date` can represent — the message must not try to format them.
    expect(() => parseSchedule("1800000000000000000", now)).toThrow("Cannot schedule more than");
    expect(() => parseSchedule("999999999d", now)).toThrow("Cannot schedule more than");
    // The boundary holds: a year out is fine, a year and a day is not.
    expect(parseSchedule("365d", now)).toBe(now + 365 * 86_400_000);
    expect(() => parseSchedule("366d", now)).toThrow("Cannot schedule more than");
  });

  it("throws on garbage", () => {
    expect(() => parseSchedule("soon", now)).toThrow("Invalid schedule_at");
    expect(() => parseSchedule("", now)).toThrow("Invalid schedule_at");
  });
});

describe("unreadCount", () => {
  it("clamps a skewed counter to zero", () => {
    expect(unreadCount(10, 13)).toBe(0);
  });

  it("is zero when the member has read everything", () => {
    expect(unreadCount(10, 10)).toBe(0);
  });

  it("is the difference when posts are unread", () => {
    expect(unreadCount(10, 8)).toBe(2);
  });
});

describe("withTimeout", () => {
  it("passes the value through when the promise wins", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "too slow")).resolves.toBe("ok");
  });

  it("rejects with the given message when the deadline passes", async () => {
    await expect(withTimeout(new Promise<never>(() => {}), 5, "too slow")).rejects.toThrow(
      "too slow",
    );
  });
});

describe("createMattermostContext", () => {
  it("caches me across calls", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await ctx.me();
    await ctx.me();
    expect(client.calls.filter((c) => c[0] === "getMe")).toHaveLength(1);
  });

  it("resolves team by name once", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    expect((await ctx.team()).id).toBe("tttttttttttttttttttttttttt");
    await ctx.team();
    expect(client.calls.filter((c) => c[0] === "getTeamByName")).toHaveLength(1);
  });

  it("uses 26-char id team directly without API calls", async () => {
    const client = mockClient();
    const ctx = createMattermostContext({ ...config, team: "tttttttttttttttttttttttttt" }, client);
    expect((await ctx.team()).id).toBe("tttttttttttttttttttttttttt");
    expect(client.calls).toHaveLength(0);
  });

  it("throws on unknown team name", async () => {
    const ctx = createMattermostContext({ ...config, team: "nope" }, mockClient());
    await expect(ctx.team()).rejects.toThrow("Mattermost team not found: nope");
  });

  it("does not cache a failed team lookup", async () => {
    let attempts = 0;
    const client = mockClient({
      getTeamByName: async (name: string) => {
        attempts++;
        if (attempts === 1) throw new TypeError("fetch failed");
        return { id: "tttttttttttttttttttttttttt", name };
      },
    });
    const ctx = createMattermostContext(config, client);
    await expect(ctx.team()).rejects.toThrow("fetch failed");
    expect((await ctx.team()).id).toBe("tttttttttttttttttttttttttt");
    expect(attempts).toBe(2);
  });

  it("lets a non-404 team failure through so the registry can restate it", async () => {
    const client = mockClient({
      getTeamByName: async () => {
        throw teamError({ message: "Internal server error", status_code: 500 });
      },
    });
    const ctx = createMattermostContext(config, client);
    await expect(ctx.team()).rejects.toThrow("Internal server error");
    // Still a ClientError, so `describeClientError` can add the status and the endpoint.
    await expect(ctx.team()).rejects.toBeInstanceOf(ClientError);
  });

  it("does not blame the team name for a connection failure", async () => {
    const client = mockClient({
      getTeamByName: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const ctx = createMattermostContext(config, client);
    await expect(ctx.team()).rejects.toThrow("fetch failed");
  });

  it("resolves channel by 26-char id via getChannel", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const resolved = await ctx.resolveChannel("ccccccccccccccccccccccccc1");
    expect(resolved.name).toBe("my-channel");
    expect(client.calls).toEqual([["getChannel", "ccccccccccccccccccccccccc1"]]);
  });

  it("resolves channel by name via getChannelByName", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    const resolved = await ctx.resolveChannel("my-channel");
    expect(resolved.id).toBe("ccccccccccccccccccccccccc1");
    expect(client.calls).toEqual([
      ["getTeamByName", "my-team"],
      ["getChannelByName", "tttttttttttttttttttttttttt", "my-channel"],
    ]);
  });

  it("caches resolved channels", async () => {
    const client = mockClient();
    const ctx = createMattermostContext(config, client);
    await ctx.resolveChannel("my-channel");
    await ctx.resolveChannel("my-channel");
    expect(client.calls.filter((c) => c[0] === "getChannelByName")).toHaveLength(1);
  });

  it("throws with near-miss suggestions on unknown channel name", async () => {
    const ctx = createMattermostContext(config, mockClient());
    await expect(ctx.resolveChannel("mm-sand")).rejects.toThrow(
      "Channel not found: mm-sand. Did you mean: mm-sandbox?",
    );
  });

  it("resolves usernames in one batch and caches them", async () => {
    const batches: string[][] = [];
    const client = mockClient({
      getProfilesByIds: async (ids: string[]) => {
        batches.push(ids);
        return ids.map((id) => ({ id, username: `user-${id.slice(0, 4)}` }));
      },
    });
    const ctx = createMattermostContext(config, client);
    const first = await ctx.usernames(["aaaaaaaaaaaaaaaaaaaaaaaaa1", "aaaaaaaaaaaaaaaaaaaaaaaaa1"]);
    expect(first.get("aaaaaaaaaaaaaaaaaaaaaaaaa1")).toBe("user-aaaa");
    await ctx.usernames(["aaaaaaaaaaaaaaaaaaaaaaaaa1", "bbbbbbbbbbbbbbbbbbbbbbbbb2"]);
    expect(batches).toEqual([["aaaaaaaaaaaaaaaaaaaaaaaaa1"], ["bbbbbbbbbbbbbbbbbbbbbbbbb2"]]);
  });

  it("throws plain error on unknown channel id", async () => {
    const ctx = createMattermostContext(config, mockClient());
    await expect(ctx.resolveChannel("dddddddddddddddddddddddddd")).rejects.toThrow(
      "Channel not found: dddddddddddddddddddddddddd",
    );
  });
});
