import { describe, expect, it } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { createPrompter } from "./prompt.js";

type Handler = (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>;

/** Stands in for opencode's RPC host: keeps the handlers, records every event emitted. */
function fakeRpc() {
  const handlers: Record<string, Handler> = {};
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const rpc = {
    register: async (_definition: unknown, registered: Record<string, Handler>) => {
      Object.assign(handlers, registered);
      return {
        dispose: async () => {},
        events: {
          emit: async (name: string, data: Record<string, unknown>) => {
            events.push({ name, data });
          },
        },
      };
    },
  } as unknown as Plugin.Context["rpc"];
  /** A TUI holding `attach` open until the returned controller aborts. */
  const attach = () => {
    const controller = new AbortController();
    const closed = handlers.attach?.({}, { signal: controller.signal });
    return { controller, closed };
  };
  const reply = (requestID: unknown, approved: boolean) =>
    handlers.reply?.({ requestID, approved }, { signal: new AbortController().signal });
  const requested = async () => {
    // The request is emitted after the confirm call has set up its listeners.
    while (!events.some((event) => event.name === "request")) await Bun.sleep(1);
    return events.find((event) => event.name === "request")?.data.requestID;
  };
  return { rpc, events, attach, reply, requested };
}

const request = (signal = new AbortController().signal) => ({
  sessionID: "ses_1",
  permission: "mattermost_create_post",
  summary: "mattermost_create_post my-channel: hi",
  signal,
});

describe("createPrompter", () => {
  it("refuses at once when no TUI is attached, asking nobody", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc);
    await expect(prompter.confirm(request())).rejects.toThrow(
      "mattermost_create_post needs your confirmation, and no opencode TUI is attached to ask it in — nothing was done",
    );
    expect(fake.events).toEqual([]);
  });

  it("resolves on approval, then closes the question everywhere", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc);
    fake.attach();
    const confirmed = prompter.confirm(request());
    const id = await fake.requested();
    expect(fake.events[0]?.data).toEqual({
      requestID: id,
      sessionID: "ses_1",
      permission: "mattermost_create_post",
      summary: "mattermost_create_post my-channel: hi",
    });
    expect(await fake.reply(id, true)).toBe(true);
    await confirmed;
    expect(fake.events.at(-1)).toEqual({ name: "settled", data: { requestID: id } });
  });

  it("throws on a decline", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc);
    fake.attach();
    const confirmed = prompter.confirm(request());
    await fake.reply(await fake.requested(), false);
    await expect(confirmed).rejects.toThrow(
      "mattermost_create_post was declined by the user — nothing was done",
    );
    expect(fake.events.at(-1)?.name).toBe("settled");
  });

  it("takes the first answer and ignores the ones after it", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc);
    fake.attach();
    fake.attach();
    const confirmed = prompter.confirm(request());
    const id = await fake.requested();
    expect(await fake.reply(id, true)).toBe(true);
    expect(await fake.reply(id, false)).toBe(false);
    await confirmed;
  });

  it("gives up after the timeout", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc, 20);
    fake.attach();
    await expect(prompter.confirm(request())).rejects.toThrow(
      "mattermost_create_post was not confirmed within 0 min — nothing was done",
    );
    expect(fake.events.at(-1)?.name).toBe("settled");
  });

  it("withdraws the question when the tool call is aborted", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc);
    fake.attach();
    const controller = new AbortController();
    const confirmed = prompter.confirm(request(controller.signal));
    const id = await fake.requested();
    controller.abort(new Error("interrupted"));
    await expect(confirmed).rejects.toThrow("interrupted");
    expect(fake.events.at(-1)).toEqual({ name: "settled", data: { requestID: id } });
    // An answer that arrives after the call is gone approves nothing.
    expect(await fake.reply(id, true)).toBe(false);
  });

  it("refuses an open question once the last TUI detaches", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc);
    const first = fake.attach();
    const second = fake.attach();
    const confirmed = prompter.confirm(request());
    const id = await fake.requested();
    first.controller.abort();
    await first.closed;
    // One TUI is still there to answer, so the question stays open.
    expect(fake.events.at(-1)?.name).toBe("request");
    second.controller.abort();
    await expect(confirmed).rejects.toThrow(
      "mattermost_create_post lost its opencode TUI before an answer — nothing was done",
    );
    expect(fake.events.at(-1)).toEqual({ name: "settled", data: { requestID: id } });
  });

  it("stops counting a TUI once it detaches", async () => {
    const fake = fakeRpc();
    const prompter = await createPrompter(fake.rpc);
    const { controller, closed } = fake.attach();
    controller.abort();
    expect(await closed).toBe("closed");
    await expect(prompter.confirm(request())).rejects.toThrow("no opencode TUI is attached");
  });
});
