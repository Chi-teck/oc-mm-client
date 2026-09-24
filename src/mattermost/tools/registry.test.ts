import { describe, expect, it } from "bun:test";
import { type Client4, ClientError } from "@mattermost/client";
import type { ServerError } from "@mattermost/types/errors";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import { createTools, describeClientError } from "./registry.js";
import type { MmToolContext } from "./types.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };

const toolCtx: MmToolContext = {
  signal: new AbortController().signal,
  confirm: async () => {},
};

function clientError(data: Partial<ServerError> = {}): ClientError {
  return new ClientError(config.url, {
    message: "Unable to get the post.",
    url: `${config.url}/api/v4/posts/ppppppppppppppppppppppppp1`,
    status_code: 404,
    ...data,
  });
}

function mockClient(failure: unknown): Client4 {
  return {
    getMe: async () => ({ id: "uuuuuuuuuuuuuuuuuuuuuuuuu1", username: "mmbot" }),
    getTeamByName: async (name: string) => ({ id: "tttttttttttttttttttttttttt", name }),
    getMyChannels: async () => {
      throw failure;
    },
  } as unknown as Client4;
}

async function listChannels(failure: unknown): Promise<unknown> {
  const tools = createTools(createMattermostContext(config, mockClient(failure)));
  const listChannelsTool = tools.mattermost_list_channels;
  if (!listChannelsTool) throw new Error("mattermost_list_channels missing from the registry");
  return await listChannelsTool.execute({}, toolCtx);
}

describe("describeClientError", () => {
  it("restates a ClientError with its status and endpoint", () => {
    const described = describeClientError(clientError());
    expect(described).toBeInstanceOf(Error);
    expect((described as Error).message).toBe(
      "Mattermost API 404 /api/v4/posts/ppppppppppppppppppppppppp1: Unable to get the post.",
    );
  });

  it("keeps the original error as the cause", () => {
    const original = clientError();
    expect((describeClientError(original) as Error).cause).toBe(original);
  });

  it("says so when the server sent no message", () => {
    const described = describeClientError(clientError({ message: "", status_code: 502 }));
    expect((described as Error).message).toBe(
      "Mattermost API 502 /api/v4/posts/ppppppppppppppppppppppppp1: the server sent no message",
    );
  });

  it("drops the status and endpoint when the error carries neither", () => {
    const described = describeClientError(
      clientError({
        status_code: undefined,
        url: undefined,
        message: "Received invalid response.",
      }),
    );
    expect((described as Error).message).toBe("Mattermost API: Received invalid response.");
  });

  it("passes anything that is not a ClientError through untouched", () => {
    const own = new Error("Channel not found: nope");
    expect(describeClientError(own)).toBe(own);
  });
});

describe("createTools", () => {
  it("restates server errors raised inside a tool", async () => {
    await expect(
      listChannels(
        clientError({ status_code: 403, message: "You do not have the appropriate permissions." }),
      ),
    ).rejects.toThrow(
      "Mattermost API 403 /api/v4/posts/ppppppppppppppppppppppppp1: You do not have the appropriate permissions.",
    );
  });

  it("leaves the plugin's own errors alone", async () => {
    await expect(listChannels(new Error("Channel not found: nope"))).rejects.toThrow(
      "Channel not found: nope",
    );
  });
});
