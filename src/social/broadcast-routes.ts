import { Router, Request, Response } from "express";
import type { Prisma } from "../generated/prisma/client";
import type { SocialPlatform } from "../generated/prisma/enums";
import { prisma } from "../server/db/prisma";
import {
  deleteSocialMediaFromCloudinary,
  generateSocialMediaUploadSignature,
  verifyAndBuildSocialMediaAsset,
} from "../services/media.service";
import { adaptSocialCopyWithAi, AiAdaptAction, getAiConfigStatus } from "./ai.service";
import {
  executeBroadcast,
  getDefaultTemplateVariables,
} from "./broadcast.service";
import {
  ALLOWED_TEMPLATE_VARIABLES,
  AllowedVariableKey,
  PLATFORM_RULES,
  resolveControlledVariables,
  validatePlatformPayload,
} from "./platform-rules";
import { PROVIDERS } from "./providers";

export const adminBroadcastRouter = Router();

interface AdminReq extends Request {
  authUser?: { id: string; email: string; name: string; role: string };
}

const VALID_PLATFORMS: SocialPlatform[] = [
  "LINKEDIN",
  "TWITTER_X",
  "META_FACEBOOK",
  "META_INSTAGRAM",
  "YOUTUBE",
  "REDDIT",
  "GLASSDOOR",
];

function computePublishingCapability(
  provider: (typeof PROVIDERS)[number],
  conn: any | null,
): { canPublish: boolean; reason: string | null; status: string } {
  const rule = PLATFORM_RULES[provider.platform];
  if (!provider.apiSupported || !rule.supportsPublish) {
    return {
      canPublish: false,
      reason:
        provider.unavailableReason ||
        `${provider.displayName} does not support automated text publishing with current API scopes.`,
      status: provider.apiSupported ? "DISCONNECTED" : "NOT_CONFIGURED",
    };
  }
  if (!provider.getCredentials()) {
    return {
      canPublish: false,
      reason: `Server env missing: ${provider.requiredEnvKeys.join(", ")}`,
      status: "NOT_CONFIGURED",
    };
  }
  if (!conn || !conn.accessToken) {
    return { canPublish: false, reason: "Account not connected", status: "DISCONNECTED" };
  }
  if (!conn.isActive) {
    return { canPublish: false, reason: "Channel disabled by admin", status: "REVOKED" };
  }
  if (conn.status === "REAUTH_REQUIRED") {
    return { canPublish: false, reason: "Reauthorization required", status: "REVOKED" };
  }
  if (conn.status === "ERROR") {
    return { canPublish: false, reason: conn.lastError || "Connection error", status: "ERROR" };
  }
  if (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() <= Date.now()) {
    return { canPublish: false, reason: "OAuth token expired", status: "EXPIRED" };
  }
  if (
    rule.requiredWriteScopes.length > 0 &&
    Array.isArray(conn.scopes) &&
    conn.scopes.length > 0 &&
    !rule.requiredWriteScopes.some((s) => conn.scopes.includes(s))
  ) {
    return {
      canPublish: false,
      reason: `Missing write scope (${rule.requiredWriteScopes.join(", ")})`,
      status: "REVOKED",
    };
  }

  const expiringSoon =
    conn.tokenExpiresAt &&
    new Date(conn.tokenExpiresAt).getTime() - Date.now() <= 7 * 24 * 60 * 60 * 1000;

  return {
    canPublish: true,
    reason: null,
    status: expiringSoon ? "EXPIRING_SOON" : "CONNECTED",
  };
}

// ─── CONTEXT FOR COMPOSER ─────────────────────────────────────────────────────

adminBroadcastRouter.get("/context", async (_req: AdminReq, res: Response) => {
  try {
    const [connections, defaultVariables, recentBroadcasts] = await Promise.all([
      prisma.socialConnection.findMany(),
      getDefaultTemplateVariables(),
      prisma.socialPost.findMany({
        orderBy: { createdAt: "desc" },
        take: 15,
        include: {
          deliveryLogs: { orderBy: { createdAt: "desc" } },
          mediaAssets: { orderBy: { sortOrder: "asc" } },
          author: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const connMap = new Map(connections.map((c) => [c.platform, c]));

    const accounts = PROVIDERS.map((p) => {
      const conn = connMap.get(p.platform) || null;
      const cap = computePublishingCapability(p, conn);
      return {
        key: p.key,
        platform: p.platform,
        displayName: p.displayName,
        accountName: conn?.accountName || null,
        accountHandle: conn?.accountHandle || null,
        avatarUrl: conn?.avatarUrl || null,
        scopes: conn?.scopes || [],
        tokenExpiresAt: conn?.tokenExpiresAt || null,
        status: cap.status,
        canPublish: cap.canPublish,
        publishBlockReason: cap.reason,
        rules: PLATFORM_RULES[p.platform],
      };
    });

    return res.json({
      accounts,
      aiStatus: getAiConfigStatus(),
      defaultVariables,
      allowedVariables: ALLOWED_TEMPLATE_VARIABLES,
      recentBroadcasts,
    });
  } catch (err) {
    console.error("Broadcast context error:", err);
    return res
      .status(500)
      .json({ error: { code: "SERVER_ERROR", message: "Failed to load composer context." } });
  }
});

// ─── CLOUDINARY SIGNED UPLOAD & VERIFICATION ──────────────────────────────────

adminBroadcastRouter.post("/media/sign", (req: AdminReq, res: Response) => {
  const resourceType = req.body?.resourceType === "video" ? "video" : "image";
  try {
    const signatureData = generateSocialMediaUploadSignature(req.authUser!.id, resourceType);
    return res.json(signatureData);
  } catch (err: any) {
    return res.status(500).json({
      error: { code: "CLOUDINARY_ERROR", message: err?.message || "Failed to sign upload." },
    });
  }
});

adminBroadcastRouter.post("/media/verify", async (req: AdminReq, res: Response) => {
  const publicId = typeof req.body?.publicId === "string" ? req.body.publicId.trim() : "";
  const resourceType = req.body?.resourceType === "video" ? "video" : "image";
  const fileName =
    typeof req.body?.fileName === "string" && req.body.fileName.trim()
      ? req.body.fileName.trim().slice(0, 180)
      : "attachment";
  const altText =
    typeof req.body?.altText === "string" ? req.body.altText.trim().slice(0, 400) : "";

  if (!publicId) {
    return res
      .status(400)
      .json({ error: { code: "INVALID_INPUT", message: "publicId is required." } });
  }

  try {
    const verified = await verifyAndBuildSocialMediaAsset(
      publicId,
      resourceType,
      req.authUser!.id,
    );

    const asset = await prisma.socialMediaAsset.create({
      data: {
        uploadedById: req.authUser!.id,
        publicId: verified.publicId,
        secureUrl: verified.secureUrl,
        resourceType: verified.resourceType,
        format: verified.format,
        bytes: verified.bytes,
        width: verified.width,
        height: verified.height,
        durationSec: verified.durationSec,
        fileName,
        altText: altText || null,
      },
    });

    return res.status(201).json({ asset });
  } catch (err: any) {
    return res.status(400).json({
      error: { code: "MEDIA_VERIFY_FAILED", message: err?.message || "Media verification failed." },
    });
  }
});

adminBroadcastRouter.patch("/media/:assetId", async (req: AdminReq, res: Response) => {
  const assetId = String(req.params.assetId || "");
  const existing = await prisma.socialMediaAsset.findUnique({ where: { id: assetId } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Media asset not found." } });
  }

  const data: Record<string, any> = {};
  if (typeof req.body?.altText === "string") {
    data.altText = req.body.altText.trim().slice(0, 400) || null;
  }
  if (typeof req.body?.sortOrder === "number" && Number.isFinite(req.body.sortOrder)) {
    data.sortOrder = Math.max(0, Math.round(req.body.sortOrder));
  }

  const asset = await prisma.socialMediaAsset.update({ where: { id: assetId }, data });
  return res.json({ asset });
});

adminBroadcastRouter.delete("/media/:assetId", async (req: AdminReq, res: Response) => {
  const assetId = String(req.params.assetId || "");
  const existing = await prisma.socialMediaAsset.findUnique({ where: { id: assetId } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Media asset not found." } });
  }

  if (existing.uploadedById !== req.authUser!.id && req.authUser!.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: { code: "FORBIDDEN", message: "Not authorized to delete asset." } });
  }

  const rt = existing.resourceType === "video" ? "video" : "image";
  await deleteSocialMediaFromCloudinary(existing.publicId, rt).catch(() => {});
  await prisma.socialMediaAsset.delete({ where: { id: assetId } });

  return res.json({ deleted: true, id: assetId });
});

// ─── AI COPY ADAPTATION ───────────────────────────────────────────────────────

adminBroadcastRouter.post("/ai/adapt", async (req: AdminReq, res: Response) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  const action = req.body?.action as AiAdaptAction;
  const targetPlatform = req.body?.targetPlatform as SocialPlatform;

  if (!content) {
    return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Editor content is empty." } });
  }
  if (!VALID_PLATFORMS.includes(targetPlatform)) {
    return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Invalid target platform." } });
  }

  const aiStatus = getAiConfigStatus();
  if (!aiStatus.configured) {
    return res.status(400).json({
      error: { code: "AI_NOT_CONFIGURED", message: "GEMINI_API_KEY is not configured on the server." },
    });
  }

  try {
    const result = await adaptSocialCopyWithAi({ content, action, targetPlatform });
    return res.json(result);
  } catch (err: any) {
    return res.status(502).json({
      error: { code: "AI_ERROR", message: err?.message || "AI adaptation failed." },
    });
  }
});

// ─── CREATE / PUBLISH / SCHEDULE BROADCAST ────────────────────────────────────

adminBroadcastRouter.post("/", async (req: AdminReq, res: Response) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : null;
  const baseContent = typeof req.body?.baseContent === "string" ? req.body.baseContent : "";
  const platformContent =
    req.body?.platformContent && typeof req.body.platformContent === "object"
      ? (req.body.platformContent as Record<string, string>)
      : {};
  const variablesInput =
    req.body?.variables && typeof req.body.variables === "object"
      ? (req.body.variables as Record<string, string>)
      : {};
  const targetPlatformsRaw = Array.isArray(req.body?.targetPlatforms)
    ? req.body.targetPlatforms
    : [];
  const targetPlatforms: SocialPlatform[] = targetPlatformsRaw.filter(
    (p: unknown): p is SocialPlatform => VALID_PLATFORMS.includes(p as SocialPlatform),
  );
  const mediaAssetIds = Array.isArray(req.body?.mediaAssetIds)
    ? req.body.mediaAssetIds.filter((id: unknown): id is string => typeof id === "string")
    : [];

  const mode = req.body?.mode === "SCHEDULE" ? "SCHEDULE" : req.body?.mode === "DRAFT" ? "DRAFT" : "IMMEDIATE";
  const scheduledForRaw = typeof req.body?.scheduledFor === "string" ? req.body.scheduledFor : null;
  const timezone = typeof req.body?.timezone === "string" ? req.body.timezone.slice(0, 80) : "UTC";

  if (!baseContent.trim() && mediaAssetIds.length === 0) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "Master content or at least one media asset is required." },
    });
  }

  if (mode !== "DRAFT" && targetPlatforms.length === 0) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "Select at least one connected target channel." },
    });
  }

  let scheduledFor: Date | null = null;
  if (mode === "SCHEDULE") {
    if (!scheduledForRaw) {
      return res.status(400).json({
        error: { code: "INVALID_INPUT", message: "Scheduled date/time is required." },
      });
    }
    scheduledFor = new Date(scheduledForRaw);
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now() + 15000) {
      return res.status(400).json({
        error: { code: "INVALID_SCHEDULE_TIME", message: "Scheduled execution time must be in the future." },
      });
    }
  }

  // Load attached media assets from DB
  const assets = mediaAssetIds.length
    ? await prisma.socialMediaAsset.findMany({ where: { id: { in: mediaAssetIds } } })
    : [];

  // Validate controlled variables & platform limits for non-drafts
  if (mode !== "DRAFT") {
    const defaults = await getDefaultTemplateVariables();
    const mergedVars: Record<AllowedVariableKey, string> = { ...defaults };
    for (const k of ALLOWED_TEMPLATE_VARIABLES) {
      if (typeof variablesInput[k] === "string" && variablesInput[k].trim()) {
        mergedVars[k] = variablesInput[k].trim();
      }
    }

    for (const platform of targetPlatforms) {
      const rawText =
        typeof platformContent[platform] === "string" && platformContent[platform].trim()
          ? platformContent[platform]
          : baseContent;

      try {
        const { resolved } = resolveControlledVariables(rawText, mergedVars, true);
        const check = validatePlatformPayload(platform, resolved, assets);
        if (!check.valid) {
          return res.status(400).json({
            error: {
              code: "VALIDATION_FAILED",
              message: `${PLATFORM_RULES[platform].displayName}: ${check.errors.join(" ")}`,
            },
          });
        }
      } catch (err: any) {
        return res.status(400).json({
          error: { code: "VARIABLE_ERROR", message: err?.message || "Invalid template variable." },
        });
      }
    }
  }

  const created = await prisma.socialPost.create({
    data: {
      title,
      baseContent,
      platformContent: platformContent as Prisma.InputJsonValue,
      variables: variablesInput as Prisma.InputJsonValue,
      mediaUrls: assets.map((a) => a.secureUrl),
      targetPlatforms,
      status: mode === "SCHEDULE" ? "SCHEDULED" : mode === "DRAFT" ? "DRAFT" : "PROCESSING",
      scheduledFor,
      timezone,
      authorId: req.authUser!.id,
    },
  });

  // Link media assets & preserve order
  for (let i = 0; i < mediaAssetIds.length; i++) {
    await prisma.socialMediaAsset
      .update({
        where: { id: mediaAssetIds[i]! },
        data: { postId: created.id, sortOrder: i },
      })
      .catch(() => {});
  }

  if (mode === "IMMEDIATE") {
    const executed = await executeBroadcast(created.id, req.authUser!.id);
    return res.status(201).json({ broadcast: executed });
  }

  await prisma.auditLog
    .create({
      data: {
        actorId: req.authUser!.id,
        action: mode === "SCHEDULE" ? "BROADCAST_SCHEDULED" : "BROADCAST_DRAFT_SAVED",
        entity: "SocialPost",
        entityId: created.id,
        meta: { targetPlatforms, scheduledFor } as Prisma.InputJsonValue,
      },
    })
    .catch(() => {});

  const full = await prisma.socialPost.findUnique({
    where: { id: created.id },
    include: {
      deliveryLogs: true,
      mediaAssets: { orderBy: { sortOrder: "asc" } },
    },
  });

  return res.status(201).json({ broadcast: full });
});

adminBroadcastRouter.post("/:id/cancel", async (req: AdminReq, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.socialPost.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Broadcast not found." } });
  }
  if (existing.status !== "SCHEDULED") {
    return res.status(400).json({
      error: { code: "INVALID_STATE", message: "Only scheduled broadcasts can be cancelled." },
    });
  }

  const updated = await prisma.socialPost.update({
    where: { id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
    include: { deliveryLogs: true, mediaAssets: { orderBy: { sortOrder: "asc" } } },
  });

  return res.json({ broadcast: updated });
});

adminBroadcastRouter.post("/:id/retry", async (req: AdminReq, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.socialPost.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Broadcast not found." } });
  }

  const updated = await executeBroadcast(id, req.authUser!.id);
  return res.json({ broadcast: updated });
});
