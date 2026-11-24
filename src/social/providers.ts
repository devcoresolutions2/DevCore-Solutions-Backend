import crypto from "node:crypto";
import type { SocialPlatform } from "../generated/prisma/enums";

export type ProviderKey =
  | "linkedin"
  | "x"
  | "meta"
  | "youtube"
  | "reddit"
  | "glassdoor";

export interface ProviderDefinition {
  key: ProviderKey;
  platform: SocialPlatform;
  displayName: string;
  subtitle: string;
  apiLabel: string;
  apiSupported: boolean;
  supportsPkce: boolean;
  defaultScopes: string[];
  requiredEnvKeys: string[];
  getCredentials: () => { clientId: string; clientSecret: string } | null;
  authorizeUrl?: string;
  tokenUrl?: string;
  healthCheckUrl?: string;
  unavailableReason?: string;
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    key: "linkedin",
    platform: "LINKEDIN",
    displayName: "LinkedIn",
    subtitle: "Organization & Company Page Publishing",
    apiLabel: "LinkedIn Marketing / OAuth 2.0",
    apiSupported: true,
    supportsPkce: false,
    defaultScopes: ["openid", "profile", "email", "w_member_social"],
    requiredEnvKeys: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    getCredentials: () => {
      const clientId = process.env.LINKEDIN_CLIENT_ID?.trim();
      const clientSecret = process.env.LINKEDIN_CLIENT_SECRET?.trim();
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    },
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    healthCheckUrl: "https://api.linkedin.com/v2/userinfo",
  },
  {
    key: "x",
    platform: "TWITTER_X",
    displayName: "X (Twitter)",
    subtitle: "Developer Stream & Post Dispatch",
    apiLabel: "X API v2 OAuth 2.0 + PKCE",
    apiSupported: true,
    supportsPkce: true,
    defaultScopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    requiredEnvKeys: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
    getCredentials: () => {
      const clientId = process.env.X_CLIENT_ID?.trim();
      const clientSecret = process.env.X_CLIENT_SECRET?.trim();
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    },
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    healthCheckUrl: "https://api.twitter.com/2/users/me",
  },
  {
    key: "meta",
    platform: "META_FACEBOOK",
    displayName: "Meta Platforms",
    subtitle: "Facebook Pages & Instagram Graph",
    apiLabel: "Meta Graph API v20.0",
    apiSupported: true,
    supportsPkce: false,
    defaultScopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    requiredEnvKeys: ["META_APP_ID", "META_APP_SECRET"],
    getCredentials: () => {
      const clientId = process.env.META_APP_ID?.trim();
      const clientSecret = process.env.META_APP_SECRET?.trim();
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    },
    authorizeUrl: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
    healthCheckUrl: "https://graph.facebook.com/v20.0/me?fields=id,name",
  },
  {
    key: "youtube",
    platform: "YOUTUBE",
    displayName: "YouTube",
    subtitle: "Channel & Video Metadata Sync",
    apiLabel: "YouTube Data API v3 (Google OAuth)",
    apiSupported: true,
    supportsPkce: true,
    defaultScopes: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    requiredEnvKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    getCredentials: () => {
      const clientId = (process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)?.trim();
      const clientSecret = (
        process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
      )?.trim();
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    },
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    healthCheckUrl: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
  },
  {
    key: "reddit",
    platform: "REDDIT",
    displayName: "Reddit",
    subtitle: "Community & Subreddit Syndication",
    apiLabel: "Reddit OAuth 2.0",
    apiSupported: true,
    supportsPkce: false,
    defaultScopes: ["identity", "read", "submit"],
    requiredEnvKeys: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    getCredentials: () => {
      const clientId = process.env.REDDIT_CLIENT_ID?.trim();
      const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim();
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    },
    authorizeUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    healthCheckUrl: "https://oauth.reddit.com/api/v1/me",
  },
  {
    key: "glassdoor",
    platform: "GLASSDOOR",
    displayName: "Glassdoor",
    subtitle: "Employer Brand & Review Monitoring",
    apiLabel: "No Public OAuth Syndication API",
    apiSupported: false,
    supportsPkce: false,
    defaultScopes: [],
    requiredEnvKeys: [],
    getCredentials: () => null,
    unavailableReason:
      "Glassdoor does not provide a public self-serve OAuth 2.0 or posting API. Employer profiles require manual link management or an approved partner agreement.",
  },
];

export function getProviderByKey(key: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.key === key.toLowerCase());
}

export function getProviderByPlatform(platform: SocialPlatform): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.platform === platform);
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function buildRedirectUri(reqOrigin: string, key: ProviderKey): string {
  const base = (process.env.BACKEND_PUBLIC_URL || reqOrigin).replace(/\/+$/, "");
  return `${base}/api/admin/social/oauth/${key}/callback`;
}

export function buildAuthorizeUrl(params: {
  provider: ProviderDefinition;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}): string {
  const { provider, clientId, redirectUri, state, codeChallenge } = params;
  if (!provider.authorizeUrl) {
    throw new Error(`${provider.displayName} does not support OAuth authorization.`);
  }

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", provider.defaultScopes.join(" "));
  url.searchParams.set("state", state);

  if (provider.supportsPkce && codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  if (provider.key === "youtube") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  if (provider.key === "reddit") {
    url.searchParams.set("duration", "permanent");
  }

  return url.toString();
}

export async function exchangeOAuthCode(params: {
  provider: ProviderDefinition;
  code: string;
  redirectUri: string;
  codeVerifier?: string | null;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scopes: string[];
}> {
  const creds = params.provider.getCredentials();
  if (!creds || !params.provider.tokenUrl) {
    throw new Error(`${params.provider.displayName} OAuth credentials are not configured.`);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
  });

  if (params.provider.supportsPkce && params.codeVerifier) {
    body.set("code_verifier", params.codeVerifier);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (params.provider.key === "x" || params.provider.key === "reddit") {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
    if (params.provider.key === "reddit") {
      headers["User-Agent"] = "DevCore-Admin/1.0";
    }
  } else {
    body.set("client_id", creds.clientId);
    body.set("client_secret", creds.clientSecret);
  }

  const res = await fetch(params.provider.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(12000),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    const errMsg =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      `Token exchange failed with HTTP ${res.status}`;
    throw new Error(errMsg);
  }

  const scopeRaw = typeof data.scope === "string" ? data.scope : "";
  const scopes = scopeRaw
    ? scopeRaw.split(/[\s,]+/).filter(Boolean)
    : params.provider.defaultScopes;

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    scopes,
  };
}

export async function fetchProviderProfile(
  provider: ProviderDefinition,
  accessToken: string,
): Promise<{
  accountId: string;
  accountName: string;
  accountHandle?: string;
  avatarUrl?: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}> {
  if (!provider.healthCheckUrl) {
    throw new Error(`${provider.displayName} does not support live profile sync.`);
  }

  const start = Date.now();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (provider.key === "reddit") {
    headers["User-Agent"] = "DevCore-Admin/1.0";
  }

  const res = await fetch(provider.healthCheckUrl, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const latencyMs = Date.now() - start;

  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const errMsg =
      data?.error?.message ||
      data?.detail ||
      data?.message ||
      `Provider API returned HTTP ${res.status}`;
    const err = new Error(String(errMsg)) as Error & { statusCode?: number };
    err.statusCode = res.status;
    throw err;
  }

  switch (provider.key) {
    case "linkedin":
      return {
        accountId: String(data.sub || "linkedin-user"),
        accountName: String(data.name || data.email || "LinkedIn Account"),
        accountHandle: typeof data.email === "string" ? data.email : undefined,
        avatarUrl: typeof data.picture === "string" ? data.picture : undefined,
        latencyMs,
      };
    case "x": {
      const user = data.data || {};
      return {
        accountId: String(user.id || "x-user"),
        accountName: String(user.name || "X Account"),
        accountHandle: user.username ? `@${user.username}` : undefined,
        latencyMs,
      };
    }
    case "meta":
      return {
        accountId: String(data.id || "meta-user"),
        accountName: String(data.name || "Meta Account"),
        latencyMs,
      };
    case "youtube": {
      const ch = Array.isArray(data.items) && data.items[0] ? data.items[0] : null;
      const snippet = ch?.snippet || {};
      return {
        accountId: String(ch?.id || "youtube-channel"),
        accountName: String(snippet.title || "YouTube Channel"),
        accountHandle: snippet.customUrl ? String(snippet.customUrl) : undefined,
        avatarUrl: snippet.thumbnails?.default?.url
          ? String(snippet.thumbnails.default.url)
          : undefined,
        latencyMs,
      };
    }
    case "reddit":
      return {
        accountId: String(data.id || data.name || "reddit-user"),
        accountName: String(data.name || "Reddit Account"),
        accountHandle: data.name ? `u/${data.name}` : undefined,
        avatarUrl: typeof data.icon_img === "string" ? data.icon_img.split("?")[0] : undefined,
        latencyMs,
      };
    default:
      throw new Error(`Unsupported provider profile fetch: ${provider.key}`);
  }
}
