import { Client4 } from "@mattermost/client";

export interface MattermostConfig {
  url: string;
  token: string;
}

export function createMattermostClient(config: MattermostConfig): Client4 {
  const client = new Client4();
  client.setUrl(config.url);
  client.setToken(config.token);
  // The server translates its error messages per request, from `Accept-Language` alone — the
  // token user's own locale is not consulted. Without the header the instance's default locale
  // wins, so a Russian server answers an English tool with "Не удалось получить сообщение."
  client.setAcceptLanguage("en");
  return client;
}
