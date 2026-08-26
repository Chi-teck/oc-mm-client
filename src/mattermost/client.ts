import { Client4 } from "@mattermost/client";

export interface MattermostConfig {
  url: string;
  token: string;
}

export function createMattermostClient(config: MattermostConfig): Client4 {
  const client = new Client4();
  // `getBaseRoute()` is plain concatenation — `${url}/api/v4` — so a trailing slash or a stray
  // newline from the environment lands inside every route the client builds, and in the paths
  // `api.ts` prints. Bun's fetch normalises a leading `//` away before the request goes out, so
  // this is hygiene, not a live failure; other runtimes need not be as forgiving.
  client.setUrl(config.url.trim().replace(/\/+$/, ""));
  client.setToken(config.token);
  // The server translates its error messages per request, from `Accept-Language` alone — the
  // token user's own locale is not consulted. Without the header the instance's default locale
  // wins, so a Russian server answers an English tool with "Не удалось получить сообщение."
  client.setAcceptLanguage("en");
  return client;
}
