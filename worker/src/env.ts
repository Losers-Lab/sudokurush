export type Env = {
  AppAssets: Fetcher;
  ROOM: DurableObjectNamespace;
  BROKER: DurableObjectNamespace;
  LIMITS_KV: KVNamespace | undefined;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string | undefined;
  OPEN_ROOMS: string | undefined;
  /** Lobby roster cap; defaults to shared/protocol DEFAULT_MAX_PLAYERS. */
  MAX_PLAYERS: string | undefined;
  CF_ACCOUNT_ID: string | undefined;
  CF_API_TOKEN: string | undefined;
};
