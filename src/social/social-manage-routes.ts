import { Router, Response } from "express";
import type { Prisma } from "../generated/prisma/client";
import type { PostStatus, SocialPlatform } from "../generated/prisma/enums";
import { prisma } from "../server/db/prisma";
import {
  AuthenticatedAdminRequest,
  escapeCsvCell,
  recordAdminAudit,
} from "../security/admin-middleware";
import { executeBroadcast, getSchedulerDiagnostics } from "./broadcast.service";
import { PROVIDERS } from "./providers";
import { PLATFORM_RULES } from "./platform-rules";

export const adminSocialManageRouter = Router();

const VALID_STATUSES: PostStatus[] = [
  "DRAFT",
  "SCHEDULED",
  "PROCESSING",
  "PUBLISHED",
  "PARTIAL_FAILED",
  "FAILED",
  "CANCELLED",
];

const VALID_PLATFORMS: SocialPlatform[] = [
  "LINKEDIN",
  "TWITTER_X",
  "META_FACEBOOK",
  "META_INSTAGRAM",
  "YOUTUBE",
  "REDDIT",
  "GLASSDOOR",
];

function resolveDateRange(preset?: string, start?: string, end?: string) {
  const now = new Date();
  if (!preset || preset === "all") return undefined;
  if (preset === "today") {
    const s = new Date(now);
    s.setUTCHours(0, 0, 0, 0);
    return { gte: s };
  }
  if (preset === "7d") return { gte: new Date(now.getTime() - 7 * 86400000) };
  if (preset === "30d") return { gte: new Date(now.getTime() - 30 * 86400000) };
  if (preset === "90d") return { gte: new Date(now.getTime() - 90 * 86400000) };
  if (preset === "month") {
    return { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) };
  }
  if (preset === "custom") {
    const filter: { gte?: Date; lte?: Date } = {};
    if (start) {
      const d = new Date(start);
      if (!Number.isNaN(d.getTime())) filter.gte = d;
    }
    if (end) {
      const d = new Date(end);
      if (!Number.isNaN(d.getTime())) {
        d.setUTCHours(23, 59, 59, 999);
        filter.lte = d;
      }
    }
    return Object.keys(filter).length > 0 ? filter : undefined;
  }
  return undefined;
}

// ─── ANALYTICS & DIAGNOSTICS ──────────────────────────────────────────────────

adminSocialManageRouter.get("/analytics", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const datePreset = typeof req.query.dateRange === "string" ? req.query.dateRange : "30d";
    const createdAtFilter = resolveDateRange(
      datePreset,
      typeof req.query.startDate === "string" ? req.query.startDate : undefined,
      typeof req.query.endDate === "string" ? req.query.endDate : undefined,
    );

    const postWhere: Prisma.SocialPostWhereInput = createdAtFilter ? { createdAt: createdAtFilter } : {};

    const [
      totalDispatches,
      statusGroups,
      eligibleDeliveries,
      successfulDeliveries,
      failedDeliveries,
      connections,
      diagnostics,
    ] = await Promise.all([
      prisma.socialPost.count({ where: postWhere }),
      prisma.socialPost.groupBy({
        by: ["status"],
        where: postWhere,
        _count: { _all: true },
      }),
      prisma.socialDeliveryLog.count({
        where: {
          ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
          status: { in: ["SUCCESS", "FAILED"] },
        },
      }),
      prisma.socialDeliveryLog.count({
        where: {
          ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
          status: "SUCCESS",
        },
      }),
      prisma.socialDeliveryLog.findMany({
        where: { status: "FAILED" },
        orderBy: { createdAt: "desc" },
        take: 25,
        include: { post: { select: { id: true, status: true, baseContent: true } } },
      }),
      prisma.socialConnection.findMany(),
      getSchedulerDiagnostics(),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const g of statusGroups) {
      statusCounts[g.status] = g._count._all;
    }

    const successRate =
      eligibleDeliveries > 0
        ? Math.round((successfulDeliveries / eligibleDeliveries) * 1000) / 10
        : null;

    const connMap = new Map(connections.map((c) => [c.platform, c]));
    const platformHealth = PROVIDERS.map((p) => {
      const conn = connMap.get(p.platform);
      const creds = Boolean(p.getCredentials());
      const rule = PLATFORM_RULES[p.platform];
      let status = "DISCONNECTED";
      if (!p.apiSupported || !rule.supportsPublish) status = "PUBLISHING_UNSUPPORTED";
      else if (!creds) status = "NOT_CONFIGURED";
      else if (!conn || !conn.accessToken) status = "DISCONNECTED";
      else if (!conn.isActive) status = "DISABLED";
      else if (conn.status === "REAUTH_REQUIRED") status = "REVOKED";
      else if (conn.status === "ERROR") status = "ERROR";
      else if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() <= Date.now()) status = "EXPIRED";
      else if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() <= 7 * 86400000)
        status = "EXPIRING_SOON";
      else status = "CONNECTED";

      return {
        key: p.key,
        platform: p.platform,
        displayName: p.displayName,
        status,
        accountName: conn?.accountName || null,
        lastHealthCheckAt: conn?.lastHealthCheckAt || null,
        lastLatencyMs: conn?.lastLatencyMs ?? null,
        lastError: conn?.lastError || null,
        canPublish: status === "CONNECTED" || status === "EXPIRING_SOON",
      };
    });

    // Summarize actionable failed deliveries (only for non-cancelled posts)
    const actionableFailed = failedDeliveries.filter(
      (f) => f.post && f.post.status !== "CANCELLED",
    );

    return res.json({
      analytics: {
        totalDispatches,
        successfulDeliveries,
        eligibleDeliveries,
        successRate,
        pendingScheduledCount:
          (statusCounts["SCHEDULED"] || 0) + (statusCounts["PROCESSING"] || 0),
        failedCount: (statusCounts["FAILED"] || 0) + (statusCounts["PARTIAL_FAILED"] || 0),
        statusCounts,
        nextScheduled: diagnostics.nextScheduled,
      },
      failedAlert: {
        affectedDeliveriesCount: actionableFailed.length,
        affectedBroadcastIds: Array.from(new Set(actionableFailed.map((f) => f.postId))),
        affectedPlatforms: Array.from(new Set(actionableFailed.map((f) => f.platform))),
        latestFailureAt: actionableFailed[0]?.createdAt || null,
        errors: Array.from(
          new Set(
            actionableFailed
              .map((f) => (f.error as Record<string, any> | null)?.message)
              .filter(Boolean),
          ),
        ).slice(0, 5),
      },
      platformHealth,
      diagnostics,
    });
  } catch (err) {
    console.error("Social manage analytics error:", err);
    return res
      .status(500)
      .json({ error: { code: "SERVER_ERROR", message: "Failed to load broadcast analytics." } });
  }
});

// ─── LIST / SEARCH / FILTER / PAGINATE BROADCASTS ─────────────────────────────

adminSocialManageRouter.get("/broadcasts", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "10"), 10) || 10));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const statusParam = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL";
    const platformParam = typeof req.query.platform === "string" ? req.query.platform.toUpperCase() : "ALL";
    const dateRange = typeof req.query.dateRange === "string" ? req.query.dateRange : "all";
    const sortBy = typeof req.query.sortBy === "string" ? req.query.sortBy : "createdAt";
    const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";

    const createdAtFilter = resolveDateRange(
      dateRange,
      typeof req.query.startDate === "string" ? req.query.startDate : undefined,
      typeof req.query.endDate === "string" ? req.query.endDate : undefined,
    );

    const where: Prisma.SocialPostWhereInput = {};
    if (createdAtFilter) where.createdAt = createdAtFilter;
    if (statusParam !== "ALL" && VALID_STATUSES.includes(statusParam as PostStatus)) {
      where.status = statusParam as PostStatus;
    }
    if (platformParam !== "ALL" && VALID_PLATFORMS.includes(platformParam as SocialPlatform)) {
      where.targetPlatforms = { has: platformParam as SocialPlatform };
    }
    if (search) {
      where.OR = [
        { id: { contains: search, mode: "insensitive" } },
        { title: { contains: search, mode: "insensitive" } },
        { baseContent: { contains: search, mode: "insensitive" } },
        { deliveryLogs: { some: { externalPostId: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const orderBy: Prisma.SocialPostOrderByWithRelationInput =
      sortBy === "scheduledFor"
        ? { scheduledFor: sortDir }
        : sortBy === "publishedAt"
          ? { publishedAt: sortDir }
          : sortBy === "status"
            ? { status: sortDir }
            : { createdAt: sortDir };

    const [total, items] = await Promise.all([
      prisma.socialPost.count({ where }),
      prisma.socialPost.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          deliveryLogs: { orderBy: { createdAt: "desc" } },
          mediaAssets: { orderBy: { sortOrder: "asc" } },
          author: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    return res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error("List broadcasts error:", err);
    return res
      .status(500)
      .json({ error: { code: "SERVER_ERROR", message: "Failed to list broadcasts." } });
  }
});

// ─── EXPORT DISPATCH AUDIT CSV ────────────────────────────────────────────────

adminSocialManageRouter.get("/export", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const statusParam = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL";
    const where: Prisma.SocialPostWhereInput = {};
    if (statusParam !== "ALL" && VALID_STATUSES.includes(statusParam as PostStatus)) {
      where.status = statusParam as PostStatus;
    }

    const posts = await prisma.socialPost.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 1000,
      include: {
        deliveryLogs: true,
        author: { select: { name: true, email: true } },
      },
    });

    const headers = [
      "Broadcast ID",
      "Title",
      "Status",
      "Target Platforms",
      "Created At (UTC)",
      "Scheduled For (UTC)",
      "Published At (UTC)",
      "Creator",
      "Delivery Results",
      "External URLs",
      "Latest Error",
    ];

    const rows = posts.map((p) => {
      const results = p.deliveryLogs.map((l) => `${l.platform}:${l.status}`).join(" | ");
      const urls = p.deliveryLogs
        .map((l) => l.externalUrl)
        .filter(Boolean)
        .join(" | ");
      const errs = p.deliveryLogs
        .map((l) => (l.error as Record<string, any> | null)?.message)
        .filter(Boolean)
        .join(" | ");

      return [
        escapeCsvCell(p.id),
        escapeCsvCell(p.title || p.baseContent.slice(0, 60)),
        escapeCsvCell(p.status),
        escapeCsvCell(p.targetPlatforms.join(", ")),
        escapeCsvCell(p.createdAt.toISOString()),
        escapeCsvCell(p.scheduledFor ? p.scheduledFor.toISOString() : ""),
        escapeCsvCell(p.publishedAt ? p.publishedAt.toISOString() : ""),
        escapeCsvCell(p.author?.name || p.author?.email || ""),
        escapeCsvCell(results),
        escapeCsvCell(urls),
        escapeCsvCell(errs),
      ].join(",");
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "BROADCAST_CSV_EXPORTED",
      entity: "SocialPost",
      entityId: "EXPORT",
      meta: { count: posts.length, statusFilter: statusParam },
      req,
    });

    const csv = [headers.join(","), ...rows].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="devcore-social-dispatches-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.send(csv);
  } catch (err) {
    console.error("Broadcast CSV export error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Export failed." } });
  }
});

// ─── BROADCAST DETAIL, SCHEDULE EDIT, DELETE DRAFT, RETRY FAILED ──────────────

adminSocialManageRouter.get("/broadcasts/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const post = await prisma.socialPost.findUnique({
    where: { id },
    include: {
      deliveryLogs: { orderBy: { createdAt: "desc" } },
      mediaAssets: { orderBy: { sortOrder: "asc" } },
      author: { select: { id: true, name: true, email: true } },
    },
  });
  if (!post) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Broadcast not found." } });
  }

  const auditLogs = await prisma.auditLog.findMany({
    where: { entity: "SocialPost", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  return res.json({ broadcast: post, auditLogs });
});

adminSocialManageRouter.patch("/broadcasts/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.socialPost.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Broadcast not found." } });
  }
  if (existing.status !== "DRAFT" && existing.status !== "SCHEDULED") {
    return res.status(400).json({
      error: { code: "INVALID_STATE", message: "Only DRAFT or SCHEDULED broadcasts can be edited." },
    });
  }

  const data: Record<string, any> = {};
  if (typeof req.body?.scheduledFor === "string") {
    const dt = new Date(req.body.scheduledFor);
    if (Number.isNaN(dt.getTime()) || dt.getTime() <= Date.now() + 15000) {
      return res.status(400).json({
        error: { code: "INVALID_DATE", message: "Scheduled time must be in the future." },
      });
    }
    data.scheduledFor = dt;
    data.status = "SCHEDULED";
  }
  if (typeof req.body?.timezone === "string" && req.body.timezone.trim()) {
    data.timezone = req.body.timezone.trim().slice(0, 80);
  }
  if (typeof req.body?.baseContent === "string") {
    data.baseContent = req.body.baseContent;
  }

  const updated = await prisma.socialPost.update({
    where: { id },
    data,
    include: { deliveryLogs: true, mediaAssets: true },
  });

  await recordAdminAudit({
    actorId: req.authUser!.id,
    action: "BROADCAST_UPDATED",
    entity: "SocialPost",
    entityId: id,
    meta: { changedFields: Object.keys(data) },
    req,
  });

  return res.json({ broadcast: updated });
});

adminSocialManageRouter.delete("/broadcasts/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.socialPost.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Broadcast not found." } });
  }
  if (existing.status !== "DRAFT" && existing.status !== "CANCELLED") {
    return res.status(400).json({
      error: { code: "INVALID_STATE", message: "Only DRAFT or CANCELLED broadcasts can be deleted." },
    });
  }

  await prisma.socialPost.delete({ where: { id } });
  await recordAdminAudit({
    actorId: req.authUser!.id,
    action: "BROADCAST_DELETED",
    entity: "SocialPost",
    entityId: id,
    meta: { previousStatus: existing.status },
    req,
  });

  return res.json({ deleted: true, id });
});

adminSocialManageRouter.post("/retry-failed", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const failedPosts = await prisma.socialPost.findMany({
      where: { status: { in: ["FAILED", "PARTIAL_FAILED"] } },
      select: { id: true },
      take: 10,
    });

    const results: Array<{ id: string; status: string }> = [];
    for (const p of failedPosts) {
      const updated = await executeBroadcast(p.id, req.authUser!.id);
      results.push({ id: p.id, status: updated.status });
    }

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "BROADCAST_BULK_RETRY",
      entity: "SocialPost",
      entityId: "BATCH",
      meta: { retriedCount: results.length, results },
      req,
    });

    return res.json({ retriedCount: results.length, results });
  } catch (err) {
    console.error("Retry all failed error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Bulk retry failed." } });
  }
});
