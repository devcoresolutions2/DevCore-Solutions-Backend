import type { Prisma } from "../generated/prisma/client";
import type { SocialPlatform } from "../generated/prisma/enums";
import { prisma } from "../server/db/prisma";
import { decryptSecret } from "../security/encryption";
import {
  ALLOWED_TEMPLATE_VARIABLES,
  AllowedVariableKey,
  PLATFORM_RULES,
  resolveControlledVariables,
  validatePlatformPayload,
} from "./platform-rules";
import { dispatchWebhookDelivery } from "./webhook.service";

async function publishToProviderApi(params: {
  platform: SocialPlatform;
  accessToken: string;
  accountId: string;
  text: string;
  title?: string | null;
  mediaUrls: string[];
}): Promise<{ externalPostId: string; externalUrl?: string }> {
  const { platform, accessToken, accountId, text, title, mediaUrls } = params;

  switch (platform) {
    case "TWITTER_X": {
      const res = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok || !data?.data?.id) {
        throw new Error(data?.detail || data?.title || `X API error HTTP ${res.status}`);
      }
      const tweetId = String(data.data.id);
      return {
        externalPostId: tweetId,
        externalUrl: `https://x.com/i/web/status/${tweetId}`,
      };
    }

    case "LINKEDIN": {
      const authorUrn = accountId.startsWith("urn:") ? accountId : `urn:li:person:${accountId}`;
      const bodyPayload: Record<string, any> = {
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: mediaUrls.length > 0 ? "ARTICLE" : "NONE",
            ...(mediaUrls.length > 0
              ? {
                  media: [
                    {
                      status: "READY",
                      originalUrl: mediaUrls[0],
                    },
                  ],
                }
              : {}),
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      };

      const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      const postId = res.headers.get("x-restli-id") || data?.id;
      if (!res.ok || !postId) {
        throw new Error(data?.message || `LinkedIn API error HTTP ${res.status}`);
      }
      return {
        externalPostId: String(postId),
        externalUrl: `https://www.linkedin.com/feed/update/${postId}`,
      };
    }

    case "META_FACEBOOK": {
      const body = new URLSearchParams({
        message: text,
        access_token: accessToken,
      });
      if (mediaUrls[0]) {
        body.set("link", mediaUrls[0]);
      }
      const res = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(accountId)}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok || !data?.id) {
        throw new Error(data?.error?.message || `Meta Graph API error HTTP ${res.status}`);
      }
      return {
        externalPostId: String(data.id),
        externalUrl: `https://www.facebook.com/${data.id}`,
      };
    }

    case "REDDIT": {
      const body = new URLSearchParams({
        api_type: "json",
        kind: "self",
        sr: "u_" + accountId,
        title: (title || text.split("\n")[0] || "DevCore Update").slice(0, 290),
        text,
      });
      const res = await fetch("https://oauth.reddit.com/api/submit", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "DevCore-Admin/1.0",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      const postData = data?.json?.data;
      if (!res.ok || (Array.isArray(data?.json?.errors) && data.json.errors.length > 0)) {
        throw new Error(
          JSON.stringify(data?.json?.errors || data?.message || `Reddit API error HTTP ${res.status}`),
        );
      }
      return {
        externalPostId: String(postData?.id || "reddit-post"),
        externalUrl: postData?.url ? String(postData.url) : undefined,
      };
    }

    default:
      throw new Error(`${platform} does not support automated text broadcast publishing.`);
  }
}

export async function getDefaultTemplateVariables(): Promise<Record<AllowedVariableKey, string>> {
  const settings = await prisma.contactSettings.findUnique({ where: { id: "singleton" } }).catch(() => null);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://devcoresolutions.com").replace(/\/+$/, "");
  return {
    launch_url: settings?.bookingUrl || `${appUrl}/launches`,
    product_name: "DevCore Platform",
    company_name: "DevCore Solutions",
  };
}

export async function executeBroadcast(postId: string, actorId?: string) {
  const post = await prisma.socialPost.findUnique({
    where: { id: postId },
    include: { mediaAssets: { orderBy: { sortOrder: "asc" } } },
  });
  if (!post) throw new Error("Broadcast post not found.");

  const defaults = await getDefaultTemplateVariables();
  const customVars = (post.variables as Record<string, string> | null) || {};
  const mergedVars: Record<AllowedVariableKey, string> = { ...defaults };
  for (const k of ALLOWED_TEMPLATE_VARIABLES) {
    if (typeof customVars[k] === "string" && customVars[k].trim()) {
      mergedVars[k] = customVars[k].trim();
    }
  }

  const overrides = (post.platformContent as Record<string, string> | null) || {};
  const connections = await prisma.socialConnection.findMany({
    where: { platform: { in: post.targetPlatforms } },
  });
  const connMap = new Map(connections.map((c) => [c.platform, c]));

  let successCount = 0;
  let failureCount = 0;

  for (const platform of post.targetPlatforms) {
    const startedAt = Date.now();
    const rawText = typeof overrides[platform] === "string" && overrides[platform].trim()
      ? overrides[platform]
      : post.baseContent;

    try {
      const { resolved } = resolveControlledVariables(rawText, mergedVars, true);
      const validation = validatePlatformPayload(platform, resolved, post.mediaAssets);
      if (!validation.valid) {
        throw new Error(validation.errors.join(" "));
      }

      const conn = connMap.get(platform);
      if (!conn || !conn.accessToken || !conn.isActive) {
        throw new Error(`${PLATFORM_RULES[platform].displayName} is not connected or is disabled.`);
      }
      if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() <= Date.now()) {
        throw new Error(`${PLATFORM_RULES[platform].displayName} OAuth token has expired.`);
      }

      const requiredScopes = PLATFORM_RULES[platform].requiredWriteScopes;
      if (
        requiredScopes.length > 0 &&
        conn.scopes.length > 0 &&
        !requiredScopes.some((s) => conn.scopes.includes(s))
      ) {
        throw new Error(
          `Missing publishing scope (${requiredScopes.join(", ")}). Reconnect account with write permissions.`,
        );
      }

      const accessToken = decryptSecret(conn.accessToken);
      const mediaUrls = post.mediaAssets.length
        ? post.mediaAssets.map((a) => a.secureUrl)
        : post.mediaUrls;

      const published = await publishToProviderApi({
        platform,
        accessToken,
        accountId: conn.accountId,
        text: resolved,
        title: post.title,
        mediaUrls,
      });

      await prisma.socialDeliveryLog.create({
        data: {
          postId: post.id,
          platform,
          status: "SUCCESS",
          externalPostId: published.externalPostId,
          externalUrl: published.externalUrl || null,
          latencyMs: Date.now() - startedAt,
        },
      });
      successCount += 1;
    } catch (err: any) {
      failureCount += 1;
      await prisma.socialDeliveryLog.create({
        data: {
          postId: post.id,
          platform,
          status: "FAILED",
          latencyMs: Date.now() - startedAt,
          error: { message: err?.message ? String(err.message) : "Publish failed" } as Prisma.InputJsonValue,
        },
      });
    }
  }

  const finalStatus =
    successCount > 0 && failureCount === 0
      ? "PUBLISHED"
      : successCount > 0 && failureCount > 0
        ? "PARTIAL_FAILED"
        : "FAILED";

  const updated = await prisma.socialPost.update({
    where: { id: post.id },
    data: {
      status: finalStatus,
      publishedAt: successCount > 0 ? new Date() : null,
    },
    include: {
      deliveryLogs: { orderBy: { createdAt: "desc" } },
      mediaAssets: { orderBy: { sortOrder: "asc" } },
    },
  });

  // Trigger outbound webhooks subscribed to post.published or post.failed
  const webhookEvent = finalStatus === "FAILED" ? "post.failed" : "post.published";
  const webhooks = await prisma.webhookEndpoint.findMany({
    where: { isActive: true, events: { has: webhookEvent } },
  });
  for (const wh of webhooks) {
    dispatchWebhookDelivery({
      endpointId: wh.id,
      eventType: webhookEvent,
      data: {
        postId: updated.id,
        status: updated.status,
        targetPlatforms: updated.targetPlatforms,
        publishedAt: updated.publishedAt,
      },
    }).catch((e) => console.error("Webhook post dispatch error:", e));
  }

  if (actorId) {
    await prisma.auditLog
      .create({
        data: {
          actorId,
          action: finalStatus === "FAILED" ? "BROADCAST_FAILED" : "BROADCAST_PUBLISHED",
          entity: "SocialPost",
          entityId: updated.id,
          meta: { status: finalStatus, successCount, failureCount } as Prisma.InputJsonValue,
        },
      })
      .catch(() => {});
  }

  return updated;
}

export async function processDueScheduledBroadcasts(): Promise<number> {
  const due = await prisma.socialPost.findMany({
    where: {
      status: "SCHEDULED",
      scheduledFor: { lte: new Date() },
    },
    select: { id: true, authorId: true },
    take: 10,
  });

  let processed = 0;
  for (const item of due) {
    // Atomic claim prevents duplicate execution across overlapping ticks
    const claimed = await prisma.socialPost.updateMany({
      where: { id: item.id, status: "SCHEDULED" },
      data: { status: "PROCESSING" },
    });
    if (claimed.count === 1) {
      await executeBroadcast(item.id, item.authorId).catch((err) =>
        console.error(`Scheduled broadcast ${item.id} execution error:`, err),
      );
      processed += 1;
    }
  }
  return processed;
}

let schedulerStarted = false;
let lastSchedulerTickAt: Date | null = null;
let lastSchedulerDurationMs: number | null = null;

export function startBroadcastScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  lastSchedulerTickAt = new Date();
  const interval = setInterval(async () => {
    const start = Date.now();
    try {
      await processDueScheduledBroadcasts();
      lastSchedulerTickAt = new Date();
      lastSchedulerDurationMs = Date.now() - start;
    } catch (err) {
      console.error("Broadcast scheduler tick error:", err);
    }
  }, 15000);
  interval.unref();
}

export async function getSchedulerDiagnostics() {
  const [pendingCount, processingCount, failedDeliveriesCount, nextScheduled] = await Promise.all([
    prisma.socialPost.count({ where: { status: "SCHEDULED" } }),
    prisma.socialPost.count({ where: { status: "PROCESSING" } }),
    prisma.socialDeliveryLog.count({ where: { status: "FAILED" } }),
    prisma.socialPost.findFirst({
      where: { status: "SCHEDULED", scheduledFor: { not: null } },
      orderBy: { scheduledFor: "asc" },
      select: { id: true, scheduledFor: true, timezone: true },
    }),
  ]);

  return {
    workerActive: schedulerStarted,
    pollIntervalSeconds: 15,
    lastHeartbeatAt: lastSchedulerTickAt ? lastSchedulerTickAt.toISOString() : null,
    lastTickDurationMs: lastSchedulerDurationMs,
    pendingCount,
    processingCount,
    failedDeliveriesCount,
    nextScheduled,
  };
}
