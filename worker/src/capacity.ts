import type { Env } from "./env";

/**
 * Answers one question: how many simultaneously live lobbies are we willing
 * to host? null means unlimited (local dev, or a plan whose ceiling we
 * cannot read). Only NEW lobbies consult it; running games always finish.
 */
export interface RoomLimitSource {
  limit(): Promise<number | null>;
}

type PlanTier = {
  maxRooms: number;
  /** Monthly included Durable Object requests; the cost guard collapses the ceiling when burned through. */
  doRequestsPerMonth: number;
};

// Policy defaults, deliberately conservative: they exist so an unknown plan
// cannot silently admit unbounded lobbies. LIMITS_KV overrides any of this
// without a redeploy, which is the intended way to tune real numbers.
const PLAN_LIMITS: Record<string, PlanTier> = {
  free: { maxRooms: 10, doRequestsPerMonth: 3_000_000 },
  paid: { maxRooms: 500, doRequestsPerMonth: 4_000_000 },
};
const DEFAULT_TIER = PLAN_LIMITS.free;

// Plan tier and month-to-date usage move on day scales; refreshing each
// isolate a few times an hour keeps the two Cloudflare API calls per refresh
// off the admission path without staleness that matters.
const CACHE_TTL_MS = 10 * 60_000;
const LIMITS_KV_KEY = "limits";

type GraphQLResponse = {
  data?: {
    viewer?: {
      accounts?: {
        durableObjectsInvocationsAdaptiveGroups?: {
          sum?: { requests?: number };
        }[];
      }[];
    };
  };
  errors?: { message: string }[];
};

function monthStart(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class CloudflareRoomLimit implements RoomLimitSource {
  private cached: number | null = null;
  private cacheExpiresAt = 0;
  private inflight: Promise<number | null> | null = null;

  constructor(
    private readonly env: Pick<Env, "LIMITS_KV" | "CF_ACCOUNT_ID" | "CF_API_TOKEN">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async limit(): Promise<number | null> {
    if (Date.now() < this.cacheExpiresAt) {
      return this.cached;
    }
    // Collapse concurrent callers onto one refresh; admissions burst at lobby
    // creation and every player in a launching game arrives at once.
    this.inflight ??= this.resolve().then((value) => {
      this.cached = value;
      this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      this.inflight = null;
      return value;
    });
    return this.inflight;
  }

  private async resolve(): Promise<number | null> {
    const override = await this.kvOverride();
    if (override !== null) {
      return override;
    }
    const tier = await this.planTier();
    const used = await this.monthToDateRequests();
    if (used !== null && used >= tier.doRequestsPerMonth) {
      return 0;
    }
    return tier.maxRooms;
  }

  private async kvOverride(): Promise<number | null> {
    const kv = this.env.LIMITS_KV;
    if (!kv) {
      return null;
    }
    const raw = await kv.get(LIMITS_KV_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "number" && Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { maxRooms?: unknown }).maxRooms === "number"
      ) {
        return Math.max(0, Math.floor((parsed as { maxRooms: number }).maxRooms));
      }
    } catch {
      // A malformed override must not take the gate down; fall through to plan detection.
    }
    return null;
  }

  private async planTier(): Promise<PlanTier> {
    const { CF_ACCOUNT_ID: accountId, CF_API_TOKEN: apiToken } = this.env;
    if (!accountId || !apiToken) {
      // No credentials means local dev or an unconfigured deploy: unlimited
      // keeps the game playable while scale-to-zero economics still hold.
      return { maxRooms: Number.MAX_SAFE_INTEGER, doRequestsPerMonth: Number.MAX_SAFE_INTEGER };
    }
    try {
      const response = await this.fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`,
        { headers: { Authorization: `Bearer ${apiToken}` } },
      );
      const payload = (await response.json()) as {
        result?: { product?: { name?: string } }[];
      };
      const names = (payload.result ?? [])
        .map((item) => item.product?.name ?? "")
        .join(" ");
      if (/workers\s+paid/i.test(names)) {
        return PLAN_LIMITS.paid;
      }
      if (/workers\s+(free|pro)/i.test(names)) {
        return PLAN_LIMITS.free;
      }
    } catch {
      // Treated as unknown below; conservative default applies.
    }
    return DEFAULT_TIER;
  }

  private async monthToDateRequests(): Promise<number | null> {
    const { CF_ACCOUNT_ID: accountId, CF_API_TOKEN: apiToken } = this.env;
    if (!accountId || !apiToken) {
      return null;
    }
    const query = `
      query {
        viewer {
          accounts(filter: { accountTag: "${accountId}" }) {
            durableObjectsInvocationsAdaptiveGroups(
              filter: { date_geq: "${monthStart(new Date())}" }
              limit: 1
            ) {
              sum { requests }
            }
          }
        }
      }`;
    try {
      const response = await this.fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });
      const payload = (await response.json()) as GraphQLResponse;
      const groups =
        payload.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
      const requests = groups[0]?.sum?.requests;
      return typeof requests === "number" ? requests : null;
    } catch {
      // Telemetry being down must not block admissions; only the cost guard softens.
      return null;
    }
  }
}
