import { Router, Response } from "express";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../server/db/prisma";
import {
  AuthenticatedAdminRequest,
  escapeCsvCell,
  recordAdminAudit,
  requireAdminSession,
} from "../security/admin-middleware";

export const adminAuditRouter = Router();

adminAuditRouter.use(requireAdminSession(["SUPER_ADMIN", "EDITOR"]));

function resolveWindow(windowParam?: string, start?: string, end?: string) {
  const now = new Date();
  if (!windowParam || windowParam === "all") return undefined;
  if (windowParam === "24h") return { gte: new Date(now.getTime() - 24 * 3600000) };
  if (windowParam === "7d") return { gte: new Date(now.getTime() - 7 * 86400000) };
  if (windowParam === "30d") return { gte: new Date(now.getTime() - 30 * 86400000) };
  if (windowParam === "custom") {
    const f: { gte?: Date; lte?: Date } = {};
    if (start) {
      const d = new Date(start);
      if (!Number.isNaN(d.getTime())) f.gte = d;
    }
    if (end) {
      const d = new Date(end);
      if (!Number.isNaN(d.getTime())) f.lte = d;
    }
    return Object.keys(f).length > 0 ? f : undefined;
  }
  return undefined;
}

// ─── KPI STATS & FILTER OPTIONS ───────────────────────────────────────────────

adminAuditRouter.get("/stats", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 24 * 3600000);
    const windowParam = typeof req.query.window === "string" ? req.query.window : "7d";
    const windowFilter = resolveWindow(windowParam);

    const [mutations24h, roleEscalations, deniedEvents, authFailures] = await Promise.all([
      prisma.auditLog.count({ where: { createdAt: { gte: since24h } } }),
      prisma.auditLog.count({
        where: {
          action: "USER_ROLE_CHANGED",
          ...(windowFilter ? { createdAt: windowFilter } : {}),
        },
      }),
      prisma.auditLog.count({
        where: {
          action: "ACCESS_DENIED",
          ...(windowFilter ? { createdAt: windowFilter } : {}),
        },
      }),
      prisma.authEvent.count({
        where: {
          status: "FAILED",
          ...(windowFilter ? { createdAt: windowFilter } : {}),
        },
      }),
    ]);

    return res.json({
      stats: {
        mutations24h,
        privilegedChanges: roleEscalations,
        accessDenialsAndFailures: deniedEvents + authFailures,
        integrityStatus: "APPEND_ONLY_ACTIVE",
        integrityNote:
          "Append-only database audit logging active. Hash-chain signing is not configured.",
      },
    });
  } catch (err) {
    console.error("Audit stats error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load stats." } });
  }
});

adminAuditRouter.get("/filters", async (_req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const [actionsRaw, entitiesRaw, actorIdsRaw] = await Promise.all([
      prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, take: 50 }),
      prisma.auditLog.findMany({ distinct: ["entity"], select: { entity: true }, take: 50 }),
      prisma.auditLog.findMany({ distinct: ["actorId"], select: { actorId: true }, take: 50 }),
    ]);

    const actorIds = actorIdsRaw.map((a) => a.actorId).filter(Boolean);
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];

    return res.json({
      actions: actionsRaw.map((a) => a.action),
      entities: entitiesRaw.map((e) => e.entity),
      actors,
    });
  } catch (err) {
    console.error("Audit filters error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load filters." } });
  }
});

// ─── LIST / SEARCH / LIVE STREAM AUDIT LOGS ───────────────────────────────────

adminAuditRouter.get("/", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "10"), 10) || 10));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const actorId = typeof req.query.actorId === "string" ? req.query.actorId.trim() : "";
    const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
    const entity = typeof req.query.entity === "string" ? req.query.entity.trim() : "";
    const windowParam = typeof req.query.window === "string" ? req.query.window : "7d";
    const sinceParam = typeof req.query.since === "string" ? req.query.since : undefined;

    const where: Prisma.AuditLogWhereInput = {};
    const dateFilter = resolveWindow(
      windowParam,
      typeof req.query.startDate === "string" ? req.query.startDate : undefined,
      typeof req.query.endDate === "string" ? req.query.endDate : undefined,
    );

    if (sinceParam) {
      const sinceDt = new Date(sinceParam);
      if (!Number.isNaN(sinceDt.getTime())) {
        where.createdAt = { gt: sinceDt };
      }
    } else if (dateFilter) {
      where.createdAt = dateFilter;
    }

    if (actorId) where.actorId = actorId;
    if (action) where.action = action;
    if (entity) where.entity = entity;

    if (search) {
      where.OR = [
        { id: { contains: search, mode: "insensitive" } },
        { action: { contains: search, mode: "insensitive" } },
        { entity: { contains: search, mode: "insensitive" } },
        { entityId: { contains: search, mode: "insensitive" } },
        { ip: { contains: search, mode: "insensitive" } },
      ];
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const actorIds = Array.from(new Set(logs.map((l) => l.actorId)));
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true, role: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    return res.json({
      items: logs.map((l) => ({
        id: l.id,
        actorId: l.actorId,
        actor: actorMap.get(l.actorId) || { id: l.actorId, name: "System", email: "", role: "SYSTEM" },
        action: l.action,
        entity: l.entity,
        entityId: l.entityId,
        meta: l.meta,
        ip: l.ip,
        createdAt: l.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error("List audit logs error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load audit logs." } });
  }
});

// ─── EXPORT AUDIT CSV (SUPER_ADMIN ONLY) ───────────────────────────────────────

adminAuditRouter.get(
  "/export",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    try {
      const logs = await prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 2000,
      });

      const actorIds = Array.from(new Set(logs.map((l) => l.actorId)));
      const actors = actorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const actorMap = new Map(actors.map((a) => [a.id, a]));

      const headers = [
        "Event ID",
        "Timestamp (UTC)",
        "Actor Name",
        "Actor Email",
        "Action",
        "Entity",
        "Entity ID",
        "IP Address",
        "Metadata",
      ];

      const rows = logs.map((l) => {
        const actor = actorMap.get(l.actorId);
        return [
          escapeCsvCell(l.id),
          escapeCsvCell(l.createdAt.toISOString()),
          escapeCsvCell(actor?.name || "System"),
          escapeCsvCell(actor?.email || ""),
          escapeCsvCell(l.action),
          escapeCsvCell(l.entity),
          escapeCsvCell(l.entityId),
          escapeCsvCell(l.ip || ""),
          escapeCsvCell(l.meta ? JSON.stringify(l.meta) : ""),
        ].join(",");
      });

      await recordAdminAudit({
        actorId: req.authUser!.id,
        action: "AUDIT_CSV_EXPORTED",
        entity: "AuditLog",
        entityId: "EXPORT",
        meta: { count: logs.length },
        req,
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="devcore-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.send([headers.join(","), ...rows].join("\r\n"));
    } catch (err) {
      console.error("Audit CSV export error:", err);
      return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Export failed." } });
    }
  },
);
