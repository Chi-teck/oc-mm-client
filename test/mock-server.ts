export const MOCK_ME = { id: "uuuuuuuuuuuuuuuuuuuuuuuuu1", username: "mmbot" };
export const MOCK_TEAM = { id: "tttttttttttttttttttttttttt", name: "my-team" };
export const MOCK_CHANNEL = {
  id: "ccccccccccccccccccccccccc1",
  name: "my-channel",
  display_name: "My Channel",
  type: "P",
  total_msg_count: 3,
};

export interface MockServer {
  url: string;
  paths: string[];
  stop(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startMockMattermost(
  options: { unauthorized?: boolean; silentError?: boolean } = {},
): MockServer {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      paths.push(pathname);
      if (options.unauthorized) {
        return json({ message: "Invalid or expired session", status_code: 401 }, 401);
      }
      // A failure whose body carries no `message`, e.g. from a proxy in front of Mattermost.
      // `ClientError.message` is then empty and only the status and endpoint identify it.
      if (options.silentError) return json({ status_code: 500 }, 500);
      if (pathname === "/api/v4/users/me") return json(MOCK_ME);
      if (pathname === `/api/v4/teams/name/${MOCK_TEAM.name}`) return json(MOCK_TEAM);
      if (pathname === `/api/v4/users/me/teams/${MOCK_TEAM.id}/channels`)
        return json([MOCK_CHANNEL]);
      if (pathname === `/api/v4/teams/${MOCK_TEAM.id}/channels/name/${MOCK_CHANNEL.name}`) {
        return json(MOCK_CHANNEL);
      }
      return json({ message: `no mock route for ${pathname}`, status_code: 404 }, 404);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    paths,
    stop: () => server.stop(true),
  };
}
