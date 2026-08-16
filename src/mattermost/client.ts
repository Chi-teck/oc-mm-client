import { Client4 } from "@mattermost/client";

export interface MattermostConfig {
  url: string;
  token: string;
}

export function createMattermostClient(config: MattermostConfig): Client4 {
  const client = new Client4();
  client.setUrl(config.url);
  client.setToken(config.token);
  return client;
}
