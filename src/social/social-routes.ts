import crypto from "node:crypto";
import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../server/db/prisma";
import { hashToken } from "../security/hash";
import {
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
  getEncryptionKeyVersion,
} from "../security/encryption";
import {
  buildAuthorizeUrl,
  buildRedirectUri,
  exchangeOAuthCode,
  fetchProviderProfile,
  generatePkcePair,
  getProviderByKey,
  PROVIDERS,
  ProviderDefinition,
} from "./providers";
import {
  dispatchWebhookDelivery,
  SUPPORTED_WEBHOOK_EVENTS,
  validateWebhookUrl,
} from "./webhook.service";
import { adminBroadcastRouter } from "./broadcast-routes";
import { adminSocialManageRouter } from "./social-manage-routes";

export const adminSocialRouter = Router();

interface AdminAuthRequest extends Request {
  authUser?: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

function parseCookies(req: Request): Record<string, string> {
  const list: Record<string, string> = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      const key = parts.shift()?.trim();
      if (key) list[key] = decodeURIComponent(parts.join("="));
    });
  }
  return list;
}

async function requireAdmin(req: AdminAuthRequest, res: Response, next: NextFunction) {
  const cookies = parseCookies(req);
  const sessionToken =
    cookies["devcore_session"] || req.headers.authorization?.replace("Bearer ", "");

  if (!sessionToken) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Admin authentication required." },
    });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(sessionToken) },
      include: { user: true },
    });

    if (!session || session.revokedAt || new Date() > session.expiresAt || !session.user.isActive) {
      return res.status(401).json({
        error: { code: "SESSION_INVALID", message: "Session expired or revoked." },
      });
    }

    if (session.user.role !== "SUPER_ADMIN" && session.user.role !== "EDITOR") {
      return res.status(403).json({
        error: { code: "FORBIDDEN", message: "Insufficient permissions for Social Integrations." },
      });
    }

    req.authUser = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
    };
    next();
  } catch (err) {
    console.error("Admin social auth check error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Auth check failed." } });
  }
}

async function recordSocialAudit(params: {
  actorId: string;
  action: string;
  entity: "SocialConnection" | "WebhookEndpoint";
  entityId: string;
  meta?: Record<string, unknown>;
  req?: Request;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: params.actorId,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        meta: (params.meta || {}) as Prisma.InputJsonValue,
        ip: params.req?.ip || params.req?.socket?.remoteAddress || null,
      },
    });
  } catch (err) {
    console.error("Failed to record social audit log:", err);
  }
}

function computeEffectiveStatus(
  provider: ProviderDefinition,
  conn: {
    status: string;
    isActive: boolean;
    tokenExpiresAt: Date | null;
    accessToken: string;
  } | null,
): string {
  if (!provider.apiSupported) return "UNAVAILABLE";
  const creds = provider.getCredentials();
  if (!creds) return "NOT_CONFIGURED";
  if (!conn || !conn.accessToken) return "DISCONNECTED";
  if (!conn.isActive) return "DISABLED";
  if (conn.status === "REAUTH_REQUIRED") return "REAUTH_REQUIRED";
  if (conn.status === "ERROR") return "ERROR";
  if (conn.tokenExpiresAt) {
    const msLeft = conn.tokenExpiresAt.getTime() - Date.now();
    if (msLeft <= 0) return "EXPIRED";
    if (msLeft <= 7 * 24 * 60 * 60 * 1000) return "EXPIRING_SOON";
  }
  return "CONNECTED";
}

function serializeChannel(provider: ProviderDefinition, conn: any | null) {
  const creds = provider.getCredentials();
  const effectiveStatus = computeEffectiveStatus(provider, conn);
  return {
    key: provider.key,
    platform: provider.platform,
    displayName: provider.displayName,
    subtitle: provider.subtitle,
    apiLabel: provider.apiLabel,
    apiSupported: provider.apiSupported,
    unavailableReason: provider.unavailableReason || null,
    configured: Boolean(creds),
    requiredEnvKeys: provider.requiredEnvKeys,
    defaultScopes: provider.defaultScopes,
    status: effectiveStatus,
    isActive: conn ? Boolean(conn.isActive) : false,
    accountName: conn?.accountName || null,
    accountId: conn?.accountId || null,
    accountHandle: conn?.accountHandle || null,
    avatarUrl: conn?.avatarUrl || null,
    scopes: conn?.scopes || [],
    keyVersion: conn?.keyVersion || null,
    tokenExpiresAt: conn?.tokenExpiresAt || null,
    connectedAt: conn?.connectedAt || null,
    lastSyncAt: conn?.lastSyncAt || null,
    lastHealthCheckAt: conn?.lastHealthCheckAt || null,
    lastLatencyMs: conn?.lastLatencyMs ?? null,
    lastError: conn?.lastError || null,
  };
}

// ─── OAUTH CALLBACK (BROWSER REDIRECT FROM PROVIDER, VALIDATED VIA STATE) ─────

adminSocialRouter.get("/oauth/:key/callback", async (req: Request, res: Response) => {
  const key = String(req.params.key || "").toLowerCase();
  const frontendUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const provider = getProviderByKey(key);

  const errorParam = typeof req.query.error === "string" ? req.query.error : null;
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (!provider || !provider.apiSupported) {
    return res.redirect(`${frontendUrl}/admin/social?oauth_error=Unsupported+provider`);
  }

  if (errorParam) {
    const desc =
      typeof req.query.error_description === "string" ? req.query.error_description : errorParam;
    return res.redirect(
      `${frontendUrl}/admin/social?oauth_error=${encodeURIComponent(desc.slice(0, 180))}`,
    );
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/admin/social?oauth_error=Missing+OAuth+code+or+state`);
  }

  try {
    const oauthState = await prisma.oAuthState.findUnique({ where: { state } });
    if (!oauthState || oauthState.platform !== provider.platform) {
      return res.redirect(`${frontendUrl}/admin/social?oauth_error=Invalid+OAuth+state`);
    }

    // Consume state immediately (single-use CSRF protection)
    await prisma.oAuthState.delete({ where: { id: oauthState.id } });

    if (new Date() > oauthState.expiresAt) {
      return res.redirect(`${frontendUrl}/admin/social?oauth_error=OAuth+state+expired`);
    }

    const reqOrigin = `${req.protocol}://${req.get("host")}`;
    const redirectUri = buildRedirectUri(reqOrigin, provider.key);

    const tokenRes = await exchangeOAuthCode({
      provider,
      code,
      redirectUri,
      codeVerifier: oauthState.codeVerifier,
    });

    const profile = await fetchProviderProfile(provider, tokenRes.accessToken);
    const encryptedAccess = encryptSecret(tokenRes.accessToken);
    const encryptedRefresh = tokenRes.refreshToken
      ? encryptSecret(tokenRes.refreshToken)
      : null;

    const tokenExpiresAt = tokenRes.expiresIn
      ? new Date(Date.now() + tokenRes.expiresIn * 1000)
      : null;

    const conn = await prisma.socialConnection.upsert({
      where: { platform: provider.platform },
      create: {
        platform: provider.platform,
        accountName: profile.accountName,
        accountId: profile.accountId,
        accountHandle: profile.accountHandle || null,
        avatarUrl: profile.avatarUrl || null,
        accessToken: encryptedAccess.ciphertext,
        refreshToken: encryptedRefresh?.ciphertext || null,
        keyVersion: encryptedAccess.keyVersion,
        tokenExpiresAt,
        scopes: tokenRes.scopes,
        status: "CONNECTED",
        isActive: true,
        connectedAt: new Date(),
        connectedById: oauthState.userId,
        lastSyncAt: new Date(),
        lastHealthCheckAt: new Date(),
        lastLatencyMs: profile.latencyMs,
        lastError: null,
      },
      update: {
        accountName: profile.accountName,
        accountId: profile.accountId,
        accountHandle: profile.accountHandle || null,
        avatarUrl: profile.avatarUrl || null,
        accessToken: encryptedAccess.ciphertext,
        refreshToken: encryptedRefresh?.ciphertext || null,
        keyVersion: encryptedAccess.keyVersion,
        tokenExpiresAt,
        scopes: tokenRes.scopes,
        status: "CONNECTED",
        isActive: true,
        connectedAt: new Date(),
        connectedById: oauthState.userId,
        lastSyncAt: new Date(),
        lastHealthCheckAt: new Date(),
        lastLatencyMs: profile.latencyMs,
        lastError: null,
      },
    });

    await recordSocialAudit({
      actorId: oauthState.userId,
      action: "SOCIAL_CONNECTED",
      entity: "SocialConnection",
      entityId: conn.id,
      meta: {
        platform: provider.platform,
        accountName: profile.accountName,
        scopes: tokenRes.scopes,
      },
      req,
    });

    return res.redirect(`${frontendUrl}/admin/social?connected=${provider.key}`);
  } catch (err: any) {
    console.error(`OAuth callback error for ${key}:`, err);
    const msg = err?.message ? String(err.message).slice(0, 180) : "OAuth connection failed";
    return res.redirect(`${frontendUrl}/admin/social?oauth_error=${encodeURIComponent(msg)}`);
  }
});

// All remaining routes require authenticated Admin/Editor session
adminSocialRouter.use(requireAdmin);
adminSocialRouter.use("/broadcasts", adminBroadcastRouter);
adminSocialRouter.use("/manage", adminSocialManageRouter);

// ─── OVERVIEW & METRICS ───────────────────────────────────────────────────────

adminSocialRouter.get("/overview", async (_req: AdminAuthRequest, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [connections, webhooks, recentDeliveries, deliveries24h] = await Promise.all([
      prisma.socialConnection.findMany(),
      prisma.webhookEndpoint.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          url: true,
          events: true,
          secretPrefix: true,
          keyVersion: true,
          isActive: true,
          lastDeliveryAt: true,
          lastStatusCode: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { deliveries: true } },
        },
      }),
      prisma.webhookDelivery.findMany({
        take: 25,
        orderBy: { deliveredAt: "desc" },
        include: {
          endpoint: { select: { id: true, name: true, url: true } },
        },
      }),
      prisma.webhookDelivery.findMany({
        where: { deliveredAt: { gte: since24h } },
        select: { status: true },
      }),
    ]);

    const connByPlatform = new Map(connections.map((c) => [c.platform, c]));
    const channels = PROVIDERS.map((p) => serializeChannel(p, connByPlatform.get(p.platform) || null));

    const connectedChannels = channels.filter((c) => c.status === "CONNECTED").length;
    const expiringSoonChannels = channels.filter((c) => c.status === "EXPIRING_SOON").length;
    const errorChannels = channels.filter(
      (c) => c.status === "ERROR" || c.status === "EXPIRED" || c.status === "REAUTH_REQUIRED",
    ).length;
    const notConfiguredChannels = channels.filter((c) => c.status === "NOT_CONFIGURED").length;

    const activeWebhooks = webhooks.filter((w) => w.isActive).length;
    const failedDeliveries24h = deliveries24h.filter((d) => d.status !== "SUCCESS").length;

    return res.json({
      channels,
      metrics: {
        totalChannels: channels.length,
        connectedChannels,
        expiringSoonChannels,
        errorChannels,
        notConfiguredChannels,
        activeWebhooks,
        totalWebhooks: webhooks.length,
        totalDeliveries24h: deliveries24h.length,
        failedDeliveries24h,
        encryptionConfigured: Boolean(process.env.ENCRYPTION_MASTER_KEY?.trim()),
        encryptionKeyVersion: getEncryptionKeyVersion(),
      },
      webhooks,
      recentDeliveries,
      supportedEvents: SUPPORTED_WEBHOOK_EVENTS,
    });
  } catch (err) {
    console.error("Social overview error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load overview." } });
  }
});

// ─── PROVIDER OAUTH INITIATE, SYNC, TOGGLE, DISCONNECT ────────────────────────

adminSocialRouter.post("/providers/:key/connect", async (req: AdminAuthRequest, res: Response) => {
  const key = String(req.params.key || "").toLowerCase();
  const provider = getProviderByKey(key);
  if (!provider) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown social provider." } });
  }
  if (!provider.apiSupported) {
    return res.status(400).json({
      error: {
        code: "UNSUPPORTED_PROVIDER",
        message: provider.unavailableReason || `${provider.displayName} does not support OAuth.`,
      },
    });
  }

  const creds = provider.getCredentials();
  if (!creds) {
    return res.status(400).json({
      error: {
        code: "NOT_CONFIGURED",
        message: `${provider.displayName} OAuth credentials are missing in server environment (${provider.requiredEnvKeys.join(", ")}).`,
        missingEnvKeys: provider.requiredEnvKeys,
      },
    });
  }

  try {
    const state = crypto.randomBytes(24).toString("hex");
    const pkce = provider.supportsPkce ? generatePkcePair() : null;

    await prisma.oAuthState.create({
      data: {
        state,
        platform: provider.platform,
        codeVerifier: pkce?.codeVerifier || null,
        userId: req.authUser!.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const reqOrigin = `${req.protocol}://${req.get("host")}`;
    const redirectUri = buildRedirectUri(reqOrigin, provider.key);
    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId: creds.clientId,
      redirectUri,
      state,
      codeChallenge: pkce?.codeChallenge,
    });

    await recordSocialAudit({
      actorId: req.authUser!.id,
      action: "SOCIAL_OAUTH_INITIATED",
      entity: "SocialConnection",
      entityId: provider.platform,
      meta: { platform: provider.platform, key: provider.key },
      req,
    });

    return res.json({ authorizeUrl });
  } catch (err) {
    console.error("OAuth initiate error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to start OAuth." } });
  }
});

adminSocialRouter.post("/providers/:key/sync", async (req: AdminAuthRequest, res: Response) => {
  const key = String(req.params.key || "").toLowerCase();
  const provider = getProviderByKey(key);
  if (!provider) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown provider." } });
  }

  const conn = await prisma.socialConnection.findUnique({
    where: { platform: provider.platform },
  });
  if (!conn || !conn.accessToken) {
    return res.status(400).json({
      error: { code: "NOT_CONNECTED", message: `${provider.displayName} is not connected.` },
    });
  }

  try {
    const accessToken = decryptSecret(conn.accessToken);
    const profile = await fetchProviderProfile(provider, accessToken);

    const updated = await prisma.socialConnection.update({
      where: { id: conn.id },
      data: {
        accountName: profile.accountName,
        accountId: profile.accountId,
        accountHandle: profile.accountHandle || conn.accountHandle,
        avatarUrl: profile.avatarUrl || conn.avatarUrl,
        status: "CONNECTED",
        lastSyncAt: new Date(),
        lastHealthCheckAt: new Date(),
        lastLatencyMs: profile.latencyMs,
        lastError: null,
      },
    });

    await recordSocialAudit({
      actorId: req.authUser!.id,
      action: "SOCIAL_SYNCED",
      entity: "SocialConnection",
      entityId: conn.id,
      meta: { platform: provider.platform, latencyMs: profile.latencyMs },
      req,
    });

    return res.json({ channel: serializeChannel(provider, updated) });
  } catch (err: any) {
    const isAuthErr = err?.statusCode === 401 || err?.statusCode === 403;
    const updated = await prisma.socialConnection.update({
      where: { id: conn.id },
      data: {
        status: isAuthErr ? "REAUTH_REQUIRED" : "ERROR",
        lastHealthCheckAt: new Date(),
        lastError: err?.message ? String(err.message).slice(0, 300) : "Sync failed",
      },
    });

    return res.status(502).json({
      error: { code: "SYNC_FAILED", message: updated.lastError || "Sync failed" },
      channel: serializeChannel(provider, updated),
    });
  }
});

adminSocialRouter.post("/providers/:key/toggle", async (req: AdminAuthRequest, res: Response) => {
  const key = String(req.params.key || "").toLowerCase();
  const provider = getProviderByKey(key);
  if (!provider) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown provider." } });
  }

  const conn = await prisma.socialConnection.findUnique({
    where: { platform: provider.platform },
  });
  if (!conn) {
    return res.status(400).json({
      error: { code: "NOT_CONNECTED", message: `${provider.displayName} has no saved connection.` },
    });
  }

  const nextActive = !conn.isActive;
  const updated = await prisma.socialConnection.update({
    where: { id: conn.id },
    data: {
      isActive: nextActive,
      status: nextActive ? (conn.accessToken ? "CONNECTED" : "DISCONNECTED") : "DISABLED",
    },
  });

  await recordSocialAudit({
    actorId: req.authUser!.id,
    action: nextActive ? "SOCIAL_ENABLED" : "SOCIAL_DISABLED",
    entity: "SocialConnection",
    entityId: conn.id,
    meta: { platform: provider.platform, isActive: nextActive },
    req,
  });

  return res.json({ channel: serializeChannel(provider, updated) });
});

adminSocialRouter.post("/providers/:key/disconnect", async (req: AdminAuthRequest, res: Response) => {
  const key = String(req.params.key || "").toLowerCase();
  const provider = getProviderByKey(key);
  if (!provider) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown provider." } });
  }

  const existing = await prisma.socialConnection.findUnique({
    where: { platform: provider.platform },
  });

  if (existing) {
    await prisma.socialConnection.delete({ where: { id: existing.id } });
    await recordSocialAudit({
      actorId: req.authUser!.id,
      action: "SOCIAL_DISCONNECTED",
      entity: "SocialConnection",
      entityId: existing.id,
      meta: { platform: provider.platform, accountName: existing.accountName },
      req,
    });
  }

  return res.json({ channel: serializeChannel(provider, null) });
});

// ─── TEST ALL ENDPOINTS ───────────────────────────────────────────────────────

adminSocialRouter.post("/test-all", async (req: AdminAuthRequest, res: Response) => {
  try {
    const connections = await prisma.socialConnection.findMany();
    const connByPlatform = new Map(connections.map((c) => [c.platform, c]));

    const results = await Promise.all(
      PROVIDERS.map(async (provider) => {
        if (!provider.apiSupported) {
          return {
            key: provider.key,
            displayName: provider.displayName,
            status: "UNAVAILABLE",
            ok: false,
            latencyMs: null as number | null,
            message: provider.unavailableReason || "Provider API unavailable.",
          };
        }

        if (!provider.getCredentials()) {
          return {
            key: provider.key,
            displayName: provider.displayName,
            status: "NOT_CONFIGURED",
            ok: false,
            latencyMs: null as number | null,
            message: `Missing env credentials: ${provider.requiredEnvKeys.join(", ")}`,
          };
        }

        const conn = connByPlatform.get(provider.platform);
        if (!conn || !conn.accessToken) {
          return {
            key: provider.key,
            displayName: provider.displayName,
            status: "DISCONNECTED",
            ok: false,
            latencyMs: null as number | null,
            message: "No active OAuth connection.",
          };
        }

        if (!conn.isActive) {
          return {
            key: provider.key,
            displayName: provider.displayName,
            status: "DISABLED",
            ok: false,
            latencyMs: null as number | null,
            message: "Channel is manually disabled.",
          };
        }

        try {
          const accessToken = decryptSecret(conn.accessToken);
          const profile = await fetchProviderProfile(provider, accessToken);
          await prisma.socialConnection.update({
            where: { id: conn.id },
            data: {
              status: "CONNECTED",
              lastHealthCheckAt: new Date(),
              lastLatencyMs: profile.latencyMs,
              lastError: null,
            },
          });
          return {
            key: provider.key,
            displayName: provider.displayName,
            status: "CONNECTED",
            ok: true,
            latencyMs: profile.latencyMs,
            message: `Verified @ ${profile.accountName}`,
          };
        } catch (err: any) {
          const isAuthErr = err?.statusCode === 401 || err?.statusCode === 403;
          const msg = err?.message ? String(err.message).slice(0, 200) : "Health check failed";
          await prisma.socialConnection.update({
            where: { id: conn.id },
            data: {
              status: isAuthErr ? "REAUTH_REQUIRED" : "ERROR",
              lastHealthCheckAt: new Date(),
              lastError: msg,
            },
          });
          return {
            key: provider.key,
            displayName: provider.displayName,
            status: isAuthErr ? "REAUTH_REQUIRED" : "ERROR",
            ok: false,
            latencyMs: null as number | null,
            message: msg,
          };
        }
      }),
    );

    await recordSocialAudit({
      actorId: req.authUser!.id,
      action: "SOCIAL_TEST_ALL_RUN",
      entity: "SocialConnection",
      entityId: "ALL",
      meta: {
        checkedCount: results.length,
        passedCount: results.filter((r) => r.ok).length,
      },
      req,
    });

    return res.json({ results, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Test all endpoints error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Health check failed." } });
  }
});

// ─── AUDIT LOGS ───────────────────────────────────────────────────────────────

adminSocialRouter.get("/audit-logs", async (_req: AdminAuthRequest, res: Response) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        entity: { in: ["SocialConnection", "WebhookEndpoint"] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const actorIds = Array.from(new Set(logs.map((l) => l.actorId)));
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    return res.json({
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        entity: l.entity,
        entityId: l.entityId,
        meta: l.meta,
        ip: l.ip,
        createdAt: l.createdAt,
        actor: actorMap.get(l.actorId) || { id: l.actorId, name: "System", email: "" },
      })),
    });
  } catch (err) {
    console.error("Social audit logs error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load audit logs." } });
  }
});

// ─── CUSTOM WEBHOOK ENDPOINTS ─────────────────────────────────────────────────

adminSocialRouter.post("/webhooks", async (req: AdminAuthRequest, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  const urlRaw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const eventsRaw = Array.isArray(req.body?.events) ? req.body.events : [];

  if (!name) {
    return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Webhook name is required." } });
  }

  let validatedUrl: URL;
  try {
    validatedUrl = await validateWebhookUrl(urlRaw);
  } catch (err: any) {
    return res.status(400).json({
      error: { code: "SSRF_OR_INVALID_URL", message: err?.message || "Invalid webhook URL." },
    });
  }

  const events = eventsRaw
    .filter((e: unknown): e is string => typeof e === "string")
    .filter((e: string) => (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(e));

  if (events.length === 0) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "Select at least one valid webhook event." },
    });
  }

  try {
    const plaintextSecret = generateWebhookSecret();
    const encrypted = encryptSecret(plaintextSecret);
    const secretPrefix = `${plaintextSecret.slice(0, 18)}...${plaintextSecret.slice(-4)}`;

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name,
        url: validatedUrl.toString(),
        events,
        secretEncrypted: encrypted.ciphertext,
        secretPrefix,
        keyVersion: encrypted.keyVersion,
        isActive: true,
        createdById: req.authUser!.id,
      },
      select: {
        id: true,
        name: true,
        url: true,
        events: true,
        secretPrefix: true,
        keyVersion: true,
        isActive: true,
        lastDeliveryAt: true,
        lastStatusCode: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await recordSocialAudit({
      actorId: req.authUser!.id,
      action: "WEBHOOK_CREATED",
      entity: "WebhookEndpoint",
      entityId: endpoint.id,
      meta: { name: endpoint.name, url: endpoint.url, events: endpoint.events },
      req,
    });

    return res.status(201).json({
      webhook: endpoint,
      plaintextSecret,
    });
  } catch (err) {
    console.error("Create webhook error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create webhook." } });
  }
});

adminSocialRouter.patch("/webhooks/:id", async (req: AdminAuthRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Webhook endpoint not found." } });
  }

  const data: Record<string, any> = {};

  if (typeof req.body?.name === "string") {
    const trimmed = req.body.name.trim().slice(0, 120);
    if (!trimmed) {
      return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Name cannot be empty." } });
    }
    data.name = trimmed;
  }

  if (typeof req.body?.url === "string") {
    try {
      const validated = await validateWebhookUrl(req.body.url);
      data.url = validated.toString();
    } catch (err: any) {
      return res.status(400).json({
        error: { code: "SSRF_OR_INVALID_URL", message: err?.message || "Invalid webhook URL." },
      });
    }
  }

  if (Array.isArray(req.body?.events)) {
    const events = req.body.events
      .filter((e: unknown): e is string => typeof e === "string")
      .filter((e: string) => (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (events.length === 0) {
      return res.status(400).json({
        error: { code: "INVALID_INPUT", message: "Select at least one valid event." },
      });
    }
    data.events = events;
  }

  if (typeof req.body?.isActive === "boolean") {
    data.isActive = req.body.isActive;
  }

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      url: true,
      events: true,
      secretPrefix: true,
      keyVersion: true,
      isActive: true,
      lastDeliveryAt: true,
      lastStatusCode: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await recordSocialAudit({
    actorId: req.authUser!.id,
    action: "WEBHOOK_UPDATED",
    entity: "WebhookEndpoint",
    entityId: updated.id,
    meta: { changedFields: Object.keys(data) },
    req,
  });

  return res.json({ webhook: updated });
});

adminSocialRouter.post("/webhooks/:id/rotate-secret", async (req: AdminAuthRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Webhook endpoint not found." } });
  }

  const plaintextSecret = generateWebhookSecret();
  const encrypted = encryptSecret(plaintextSecret);
  const secretPrefix = `${plaintextSecret.slice(0, 18)}...${plaintextSecret.slice(-4)}`;

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data: {
      secretEncrypted: encrypted.ciphertext,
      secretPrefix,
      keyVersion: encrypted.keyVersion,
    },
    select: {
      id: true,
      name: true,
      url: true,
      events: true,
      secretPrefix: true,
      keyVersion: true,
      isActive: true,
      lastDeliveryAt: true,
      lastStatusCode: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await recordSocialAudit({
    actorId: req.authUser!.id,
    action: "WEBHOOK_SECRET_ROTATED",
    entity: "WebhookEndpoint",
    entityId: updated.id,
    meta: { name: updated.name, keyVersion: encrypted.keyVersion },
    req,
  });

  return res.json({ webhook: updated, plaintextSecret });
});

adminSocialRouter.post("/webhooks/:id/test", async (req: AdminAuthRequest, res: Response) => {
  const id = String(req.params.id || "");
  try {
    const delivery = await dispatchWebhookDelivery({
      endpointId: id,
      eventType: "webhook.test",
      data: {
        message: "DevCore signed webhook connectivity verification",
        triggeredBy: req.authUser!.email,
      },
    });

    await recordSocialAudit({
      actorId: req.authUser!.id,
      action: "WEBHOOK_TEST_DISPATCHED",
      entity: "WebhookEndpoint",
      entityId: id,
      meta: { status: delivery.status, responseStatus: delivery.responseStatus },
      req,
    });

    return res.json({ delivery });
  } catch (err: any) {
    return res.status(400).json({
      error: { code: "WEBHOOK_TEST_FAILED", message: err?.message || "Failed to dispatch test." },
    });
  }
});

adminSocialRouter.delete("/webhooks/:id", async (req: AdminAuthRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Webhook endpoint not found." } });
  }

  await prisma.webhookEndpoint.delete({ where: { id } });

  await recordSocialAudit({
    actorId: req.authUser!.id,
    action: "WEBHOOK_DELETED",
    entity: "WebhookEndpoint",
    entityId: id,
    meta: { name: existing.name, url: existing.url },
    req,
  });

  return res.json({ deleted: true, id });
});

adminSocialRouter.post("/deliveries/:deliveryId/retry", async (req: AdminAuthRequest, res: Response) => {
  const deliveryId = String(req.params.deliveryId || "");
  const prev = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!prev) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Delivery record not found." } });
  }

  try {
    const prevPayload = (prev.payload as Record<string, any>) || {};
    const delivery = await dispatchWebhookDelivery({
      endpointId: prev.endpointId,
      eventType: prev.eventType,
      data: (prevPayload.data as Record<string, unknown>) || { retriedFrom: prev.id },
      attemptCount: prev.attemptCount + 1,
    });
    return res.json({ delivery });
  } catch (err: any) {
    return res.status(400).json({
      error: { code: "RETRY_FAILED", message: err?.message || "Webhook retry failed." },
    });
  }
});
