import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../server/db/prisma";
import { hashToken } from "../security/hash";
import { checkRateLimit } from "../security/rate-limit";

export const publicLeadsRouter = Router();
export const publicContactEventsRouter = Router();
export const adminLeadsRouter = Router();

const VALID_SOURCES = ["ESTIMATOR", "QUICK_CALLBACK", "BOOKING", "CONTACT_FORM"] as const;
const VALID_STATUSES = ["NEW", "CONTACTED", "PROPOSAL_SENT", "WON", "ARCHIVED"] as const;
const VALID_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

type LeadSourceType = (typeof VALID_SOURCES)[number];
type LeadStatusType = (typeof VALID_STATUSES)[number];
type LeadPriorityType = (typeof VALID_PRIORITIES)[number];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

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

function parseBudgetMin(budgetStr?: string | null): number | null {
  if (!budgetStr || typeof budgetStr !== "string") return null;
  // Match first numeric sequence optionally followed by k/K/m/M
  const match = budgetStr.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!match || !match[1]) return null;
  let num = parseFloat(match[1]);
  if (Number.isNaN(num)) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") num *= 1000;
  if (suffix === "m") num *= 1000000;
  return Math.round(num);
}

function sanitizeText(val: unknown, maxLen = 4000): string {
  if (typeof val !== "string") return "";
  return val
    .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
    .trim()
    .slice(0, maxLen);
}

function resolveDateFilter(
  dateRange?: string,
  startDate?: string,
  endDate?: string
): { gte?: Date; lte?: Date } | undefined {
  const now = new Date();
  if (!dateRange || dateRange === "all") return undefined;

  if (dateRange === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { gte: start };
  }
  if (dateRange === "7d") {
    return { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
  }
  if (dateRange === "30d") {
    return { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
  }
  if (dateRange === "quarter") {
    const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
    const start = new Date(now.getFullYear(), quarterMonth, 1);
    return { gte: start };
  }
  if (dateRange === "custom") {
    const filter: { gte?: Date; lte?: Date } = {};
    if (startDate) {
      const d = new Date(startDate);
      if (!Number.isNaN(d.getTime())) filter.gte = d;
    }
    if (endDate) {
      const d = new Date(endDate);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        filter.lte = d;
      }
    }
    return Object.keys(filter).length > 0 ? filter : undefined;
  }
  return undefined;
}

interface AdminAuthRequest extends Request {
  authUser?: any;
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
        error: { code: "FORBIDDEN", message: "Insufficient permissions for Lead Management." },
      });
    }

    req.authUser = session.user;
    return next();
  } catch (err) {
    console.error("[Leads:Auth] Error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to verify admin session." },
    });
  }
}

// ─── 1. PUBLIC LEAD INTAKE ───────────────────────────────────────────────────
publicLeadsRouter.post("/", async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || "127.0.0.1";
  const rate = await checkRateLimit(`lead-intake:${ip}`, 15, 600);
  if (!rate.allowed) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many submissions. Please wait before trying again.",
        retryAfter: rate.resetInSeconds,
      },
    });
  }

  const {
    name,
    email,
    phone,
    company,
    jobTitle,
    role,
    website,
    subject,
    services,
    budget,
    budgetTier,
    currency,
    timeline,
    brief,
    message,
    pageUrl,
    referrer,
    utm,
    source,
  } = req.body;

  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return res.status(400).json({
      error: { code: "INVALID_NAME", message: "Contact name is required (min 2 characters)." },
    });
  }

  const cleanEmail = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  const cleanPhone = typeof phone === "string" && phone.trim() ? phone.trim() : null;

  if (!cleanEmail && !cleanPhone) {
    return res.status(400).json({
      error: {
        code: "CONTACT_REQUIRED",
        message: "Either an email address or phone number is required.",
      },
    });
  }

  const rawSource = String(source || "ESTIMATOR").toUpperCase();
  const normalizedSource: LeadSourceType = (VALID_SOURCES as readonly string[]).includes(rawSource)
    ? (rawSource as LeadSourceType)
    : "ESTIMATOR";

  const budgetText = typeof (budget || budgetTier) === "string" ? (budget || budgetTier).trim() : null;
  const budgetMin = parseBudgetMin(budgetText);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          source: normalizedSource,
          name: name.trim().slice(0, 120),
          email: cleanEmail,
          phone: cleanPhone,
          company: typeof company === "string" && company.trim() ? company.trim().slice(0, 120) : null,
          jobTitle:
            typeof (jobTitle || role) === "string" && (jobTitle || role).trim()
              ? (jobTitle || role).trim().slice(0, 100)
              : null,
          website: typeof website === "string" && website.trim() ? website.trim().slice(0, 255) : null,
          subject: typeof subject === "string" && subject.trim() ? subject.trim().slice(0, 200) : null,
          services: Array.isArray(services)
            ? services.filter((s) => typeof s === "string").map((s) => s.trim()).slice(0, 20)
            : [],
          budget: budgetText,
          budgetMin,
          currency: typeof currency === "string" && currency.trim() ? currency.trim().toUpperCase().slice(0, 6) : "USD",
          timeline: typeof timeline === "string" && timeline.trim() ? timeline.trim().slice(0, 100) : null,
          brief:
            typeof (brief || message) === "string" && (brief || message).trim()
              ? (brief || message).trim().slice(0, 5000)
              : null,
          pageUrl: typeof pageUrl === "string" && pageUrl.trim() ? pageUrl.trim().slice(0, 500) : null,
          referrer:
            typeof referrer === "string" && referrer.trim()
              ? referrer.trim().slice(0, 500)
              : (req.headers.referer ? String(req.headers.referer).slice(0, 500) : null),
          utm: utm && typeof utm === "object" ? utm : undefined,
          status: "NEW",
          priority: "MEDIUM",
        },
      });

      await tx.leadStatusChange.create({
        data: {
          leadId: lead.id,
          eventType: "LEAD_CREATED",
          fromStatus: null,
          toStatus: "NEW",
          details: `Ingested via ${normalizedSource}`,
        },
      });

      return lead;
    });

    const refCode = `DC-${created.createdAt.getFullYear()}-${created.id.slice(-6).toUpperCase()}`;

    return res.status(201).json({
      id: created.id,
      reference: refCode,
      status: created.status,
      createdAt: created.createdAt,
    });
  } catch (error) {
    console.error("[Public:Leads] Submission error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to save inquiry. Please try again." },
    });
  }
});

// ─── 2. PUBLIC CONTACT EVENTS (BEACON) ───────────────────────────────────────
publicContactEventsRouter.post("/", async (req: Request, res: Response) => {
  const { type, pageUrl } = req.body || {};
  const validTypes = ["WHATSAPP_CLICK", "CALL_CLICK", "EMAIL_CLICK"];
  const normalizedType = String(type || "").toUpperCase();

  if (!validTypes.includes(normalizedType)) {
    return res.status(400).json({ error: { message: "Invalid contact event type." } });
  }

  try {
    await prisma.contactEvent.create({
      data: {
        type: normalizedType as any,
        pageUrl: typeof pageUrl === "string" ? pageUrl.slice(0, 500) : "/",
      },
    });
    return res.status(201).json({ success: true });
  } catch (err) {
    console.error("[Public:ContactEvents] Error:", err);
    return res.status(500).json({ error: { message: "Failed to record contact event." } });
  }
});

// ─── 3. ADMIN LEADS ROUTER (PROTECTED) ───────────────────────────────────────
adminLeadsRouter.use(requireAdmin);

// 3A. STATS / ANALYTICS AGGREGATION
adminLeadsRouter.get("/stats", async (req: AdminAuthRequest, res: Response) => {
  const dateRange = String(req.query.dateRange || "30d");
  const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
  const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
  const slaHours = Math.max(1, Math.min(168, Number(req.query.slaHours) || 4));

  const createdAtFilter = resolveDateFilter(dateRange, startDate, endDate);
  const slaCutoff = new Date(Date.now() - slaHours * 60 * 60 * 1000);

  try {
    const [
      totalInbound,
      newLeadsCount,
      breachingSlaCount,
      activeNegotiationCount,
      pipelineAgg,
      wonAgg,
      statusGroup,
    ] = await Promise.all([
      prisma.lead.count({
        where: createdAtFilter ? { createdAt: createdAtFilter } : undefined,
      }),
      prisma.lead.count({
        where: { status: "NEW" },
      }),
      prisma.lead.count({
        where: {
          status: "NEW",
          createdAt: { lt: slaCutoff },
        },
      }),
      prisma.lead.count({
        where: {
          status: { in: ["CONTACTED", "PROPOSAL_SENT"] },
        },
      }),
      prisma.lead.aggregate({
        where: {
          status: { in: ["NEW", "CONTACTED", "PROPOSAL_SENT"] },
          budgetMin: { not: null },
        },
        _sum: { budgetMin: true },
        _count: { budgetMin: true },
      }),
      prisma.lead.aggregate({
        where: {
          status: "WON",
          budgetMin: { not: null },
        },
        _sum: { budgetMin: true },
        _count: { budgetMin: true },
      }),
      prisma.lead.groupBy({
        by: ["status"],
        _count: { _all: true },
        _sum: { budgetMin: true },
      }),
    ]);

    const statusSummary: Record<string, { count: number; budgetSum: number }> = {};
    for (const s of VALID_STATUSES) {
      statusSummary[s] = { count: 0, budgetSum: 0 };
    }
    for (const row of statusGroup) {
      statusSummary[row.status] = {
        count: row._count._all,
        budgetSum: row._sum.budgetMin || 0,
      };
    }

    return res.json({
      dateRange,
      slaHours,
      totalInbound,
      awaitingSla: {
        newCount: newLeadsCount,
        breachingCount: breachingSlaCount,
        slaHours,
      },
      activeNegotiationCount,
      pipelineValue: {
        estimatedTotal: pipelineAgg._sum.budgetMin || 0,
        leadsWithBudget: pipelineAgg._count.budgetMin || 0,
        wonEstimatedTotal: wonAgg._sum.budgetMin || 0,
        wonWithBudget: wonAgg._count.budgetMin || 0,
      },
      statusSummary,
    });
  } catch (error) {
    console.error("[Admin:Leads:Stats] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to aggregate lead statistics." },
    });
  }
});

// 3B. LIST LEADS (SEARCH + FILTERS + SERVER-SIDE PAGINATION + SORT)
adminLeadsRouter.get("/", async (req: AdminAuthRequest, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 15));
  const skip = (page - 1) * pageSize;

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const source = typeof req.query.source === "string" ? req.query.source.toUpperCase() : "ALL";
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL";
  const priority = typeof req.query.priority === "string" ? req.query.priority.toUpperCase() : "ALL";
  const assignedToId = typeof req.query.assignedToId === "string" ? req.query.assignedToId : "ALL";
  const dateRange = typeof req.query.dateRange === "string" ? req.query.dateRange : "all";
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;

  const sortByRaw = typeof req.query.sortBy === "string" ? req.query.sortBy : "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";
  const allowedSortFields = ["createdAt", "updatedAt", "budgetMin", "status", "priority"];
  const sortBy = allowedSortFields.includes(sortByRaw) ? sortByRaw : "createdAt";

  const where: any = {};

  if (source !== "ALL" && (VALID_SOURCES as readonly string[]).includes(source)) {
    where.source = source;
  }
  if (status !== "ALL" && (VALID_STATUSES as readonly string[]).includes(status)) {
    where.status = status;
  }
  if (priority !== "ALL" && (VALID_PRIORITIES as readonly string[]).includes(priority)) {
    where.priority = priority;
  }
  if (assignedToId === "UNASSIGNED") {
    where.assignedToId = null;
  } else if (assignedToId && assignedToId !== "ALL") {
    where.assignedToId = assignedToId;
  }

  const createdAtFilter = resolveDateFilter(dateRange, startDate, endDate);
  if (createdAtFilter) {
    where.createdAt = createdAtFilter;
  }

  if (q) {
    where.OR = [
      { id: { contains: q, mode: "insensitive" } },
      { name: { contains: q, mode: "insensitive" } },
      { company: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q, mode: "insensitive" } },
      { subject: { contains: q, mode: "insensitive" } },
      { brief: { contains: q, mode: "insensitive" } },
    ];
  }

  try {
    const [items, total, assignees] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
        skip,
        take: pageSize,
        include: {
          assignedTo: {
            select: { id: true, name: true, email: true, role: true, avatarUrl: true },
          },
          _count: { select: { notes: true } },
        },
      }),
      prisma.lead.count({ where }),
      prisma.user.findMany({
        where: { role: { in: ["SUPER_ADMIN", "EDITOR"] }, isActive: true },
        select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        orderBy: { name: "asc" },
      }),
    ]);

    return res.json({
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      assignees,
    });
  } catch (error) {
    console.error("[Admin:Leads:List] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to query leads." },
    });
  }
});

// 3C. EXPORT FILTERED LEADS (CSV / JSON)
adminLeadsRouter.get("/export", async (req: AdminAuthRequest, res: Response) => {
  const format = req.query.format === "json" ? "json" : "csv";
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL";
  const source = typeof req.query.source === "string" ? req.query.source.toUpperCase() : "ALL";
  const idsParam = typeof req.query.ids === "string" ? req.query.ids : "";

  const where: any = {};
  if (idsParam) {
    where.id = { in: idsParam.split(",").map((s) => s.trim()).filter(Boolean) };
  } else {
    if (status !== "ALL" && (VALID_STATUSES as readonly string[]).includes(status)) where.status = status;
    if (source !== "ALL" && (VALID_SOURCES as readonly string[]).includes(source)) where.source = source;
  }

  try {
    const leads = await prisma.lead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: 1000,
      include: {
        assignedTo: { select: { name: true, email: true } },
      },
    });

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="devcore-leads-${Date.now()}.json"`);
      return res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: leads.length, leads }, null, 2));
    }

    const csvEscape = (v: unknown) => {
      const str = v == null ? "" : String(v);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const headers = [
      "ID",
      "Name",
      "Company",
      "Email",
      "Phone",
      "Source",
      "Status",
      "Priority",
      "Budget",
      "Timeline",
      "Assigned To",
      "Created At",
    ];
    const rows = leads.map((l) =>
      [
        l.id,
        l.name,
        l.company || "",
        l.email || "",
        l.phone || "",
        l.source,
        l.status,
        l.priority,
        l.budget || "",
        l.timeline || "",
        l.assignedTo?.name || "",
        l.createdAt.toISOString(),
      ]
        .map(csvEscape)
        .join(",")
    );

    const csv = [headers.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="devcore-leads-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (error) {
    console.error("[Admin:Leads:Export] Error:", error);
    return res.status(500).json({ error: { message: "Failed to export leads." } });
  }
});

// 3D. BULK ACTIONS
adminLeadsRouter.post("/bulk", async (req: AdminAuthRequest, res: Response) => {
  const actor = req.authUser;
  const { leadIds, action, status, assignedToId } = req.body || {};

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: { message: "leadIds array is required." } });
  }

  const cleanIds = leadIds.filter((id) => typeof id === "string").slice(0, 100);

  try {
    const existingLeads = await prisma.lead.findMany({
      where: { id: { in: cleanIds } },
      select: { id: true, status: true, assignedToId: true },
    });

    if (existingLeads.length === 0) {
      return res.status(404).json({ error: { message: "No matching leads found." } });
    }

    await prisma.$transaction(async (tx) => {
      if (action === "STATUS" || action === "ARCHIVE" || action === "RESTORE") {
        const targetStatus: LeadStatusType =
          action === "ARCHIVE"
            ? "ARCHIVED"
            : action === "RESTORE"
            ? "NEW"
            : (VALID_STATUSES as readonly string[]).includes(String(status))
            ? (status as LeadStatusType)
            : "CONTACTED";

        await tx.lead.updateMany({
          where: { id: { in: existingLeads.map((l) => l.id) } },
          data: {
            status: targetStatus,
            archivedAt: targetStatus === "ARCHIVED" ? new Date() : null,
            lastContactedAt: targetStatus === "CONTACTED" ? new Date() : undefined,
          },
        });

        for (const lead of existingLeads) {
          if (lead.status !== targetStatus) {
            await tx.leadStatusChange.create({
              data: {
                leadId: lead.id,
                eventType:
                  targetStatus === "ARCHIVED"
                    ? "LEAD_ARCHIVED"
                    : lead.status === "ARCHIVED"
                    ? "LEAD_RESTORED"
                    : "STATUS_CHANGED",
                fromStatus: lead.status,
                toStatus: targetStatus,
                actorId: actor.id,
                details: `Bulk action by ${actor.name}`,
              },
            });
          }
        }
      } else if (action === "ASSIGN") {
        const targetAssignee = assignedToId ? String(assignedToId) : null;
        await tx.lead.updateMany({
          where: { id: { in: existingLeads.map((l) => l.id) } },
          data: { assignedToId: targetAssignee },
        });

        for (const lead of existingLeads) {
          await tx.leadStatusChange.create({
            data: {
              leadId: lead.id,
              eventType: "LEAD_ASSIGNED",
              fromStatus: lead.status,
              toStatus: lead.status,
              actorId: actor.id,
              details: targetAssignee ? `Bulk assigned by ${actor.name}` : `Unassigned by ${actor.name}`,
            },
          });
        }
      } else {
        throw new Error("INVALID_BULK_ACTION");
      }
    });

    return res.json({
      success: true,
      updatedCount: existingLeads.length,
      message: `Updated ${existingLeads.length} lead(s).`,
    });
  } catch (error: any) {
    if (error.message === "INVALID_BULK_ACTION") {
      return res.status(400).json({ error: { message: "Unsupported bulk action." } });
    }
    console.error("[Admin:Leads:Bulk] Error:", error);
    return res.status(500).json({ error: { message: "Bulk operation failed." } });
  }
});

// 3E. GET SINGLE LEAD DETAILS (WITH NOTES & AUDIT TIMELINE)
adminLeadsRouter.get("/:id", async (req: AdminAuthRequest, res: Response) => {
  const id = String(req.params.id || "");
  try {
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        assignedTo: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        },
        notes: {
          orderBy: { createdAt: "asc" },
          include: {
            author: {
              select: { id: true, name: true, email: true, role: true, avatarUrl: true },
            },
          },
        },
        history: {
          orderBy: { createdAt: "desc" },
          include: {
            actor: {
              select: { id: true, name: true, email: true, role: true },
            },
          },
        },
      },
    });

    if (!lead) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Lead not found." } });
    }

    return res.json({ lead });
  } catch (error) {
    console.error("[Admin:Leads:GetOne] Error:", error);
    return res.status(500).json({ error: { message: "Failed to load lead details." } });
  }
});

// 3F. UPDATE LEAD (STATUS, PRIORITY, ASSIGNMENT, FOLLOW-UP, ARCHIVE/RESTORE)
adminLeadsRouter.patch("/:id", async (req: AdminAuthRequest, res: Response) => {
  const actor = req.authUser;
  const id = String(req.params.id || "");
  const { status, priority, assignedToId, nextFollowUpAt } = req.body || {};

  try {
    const existing = await prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Lead not found." } });
    }

    const updateData: any = {};
    const eventsToCreate: Array<{
      eventType: string;
      fromStatus: LeadStatusType | null;
      toStatus: LeadStatusType;
      details: string;
    }> = [];

    let nextStatus = existing.status as LeadStatusType;

    if (status !== undefined) {
      const normalized = String(status).toUpperCase();
      if (!(VALID_STATUSES as readonly string[]).includes(normalized)) {
        return res.status(400).json({ error: { message: "Invalid lead status." } });
      }
      if (normalized !== existing.status) {
        nextStatus = normalized as LeadStatusType;
        updateData.status = nextStatus;
        if (nextStatus === "ARCHIVED") {
          updateData.archivedAt = new Date();
        } else if (existing.status === "ARCHIVED") {
          updateData.archivedAt = null;
        }
        if (nextStatus === "CONTACTED" && !existing.lastContactedAt) {
          updateData.lastContactedAt = new Date();
        }
        eventsToCreate.push({
          eventType:
            nextStatus === "ARCHIVED"
              ? "LEAD_ARCHIVED"
              : existing.status === "ARCHIVED"
              ? "LEAD_RESTORED"
              : "STATUS_CHANGED",
          fromStatus: existing.status as LeadStatusType,
          toStatus: nextStatus,
          details: `Stage changed from ${existing.status} to ${nextStatus}`,
        });
      }
    }

    if (priority !== undefined) {
      const normalizedP = String(priority).toUpperCase();
      if (!(VALID_PRIORITIES as readonly string[]).includes(normalizedP)) {
        return res.status(400).json({ error: { message: "Invalid priority value." } });
      }
      if (normalizedP !== existing.priority) {
        updateData.priority = normalizedP as LeadPriorityType;
        eventsToCreate.push({
          eventType: "PRIORITY_CHANGED",
          fromStatus: existing.status as LeadStatusType,
          toStatus: nextStatus,
          details: `Priority updated from ${existing.priority} to ${normalizedP}`,
        });
      }
    }

    if (assignedToId !== undefined) {
      const targetAssigneeId = assignedToId ? String(assignedToId) : null;
      if (targetAssigneeId !== existing.assignedToId) {
        let assigneeName = "Unassigned";
        if (targetAssigneeId) {
          const assigneeUser = await prisma.user.findFirst({
            where: { id: targetAssigneeId, role: { in: ["SUPER_ADMIN", "EDITOR"] }, isActive: true },
            select: { id: true, name: true },
          });
          if (!assigneeUser) {
            return res.status(400).json({ error: { message: "Invalid assignee selected." } });
          }
          assigneeName = assigneeUser.name;
        }
        updateData.assignedToId = targetAssigneeId;
        eventsToCreate.push({
          eventType: "LEAD_ASSIGNED",
          fromStatus: existing.status as LeadStatusType,
          toStatus: nextStatus,
          details: targetAssigneeId ? `Assigned to ${assigneeName}` : "Assignment cleared",
        });
      }
    }

    if (nextFollowUpAt !== undefined) {
      const parsedDate = nextFollowUpAt ? new Date(nextFollowUpAt) : null;
      if (parsedDate && Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: { message: "Invalid follow-up date." } });
      }
      updateData.nextFollowUpAt = parsedDate;
      eventsToCreate.push({
        eventType: "FOLLOW_UP_SCHEDULED",
        fromStatus: existing.status as LeadStatusType,
        toStatus: nextStatus,
        details: parsedDate
          ? `Follow-up scheduled for ${parsedDate.toISOString().split("T")[0]}`
          : "Follow-up date cleared",
      });
    }

    if (Object.keys(updateData).length === 0) {
      return res.json({ success: true, lead: existing });
    }

    const updatedLead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: updateData,
        include: {
          assignedTo: {
            select: { id: true, name: true, email: true, role: true, avatarUrl: true },
          },
          notes: {
            orderBy: { createdAt: "asc" },
            include: {
              author: {
                select: { id: true, name: true, email: true, role: true, avatarUrl: true },
              },
            },
          },
          history: {
            orderBy: { createdAt: "desc" },
            include: {
              actor: {
                select: { id: true, name: true, email: true, role: true },
              },
            },
          },
        },
      });

      for (const ev of eventsToCreate) {
        await tx.leadStatusChange.create({
          data: {
            leadId: id,
            eventType: ev.eventType,
            fromStatus: ev.fromStatus,
            toStatus: ev.toStatus,
            details: ev.details,
            actorId: actor.id,
          },
        });
      }

      // Refetch history to include newly created events
      const freshHistory = await tx.leadStatusChange.findMany({
        where: { leadId: id },
        orderBy: { createdAt: "desc" },
        include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      });

      return { ...updated, history: freshHistory };
    });

    return res.json({ success: true, lead: updatedLead });
  } catch (error) {
    console.error("[Admin:Leads:Patch] Error:", error);
    return res.status(500).json({ error: { message: "Failed to update lead." } });
  }
});

// 3G. APPEND INTERNAL NOTE (PERSISTENT & AUDITABLE)
adminLeadsRouter.post("/:id/notes", async (req: AdminAuthRequest, res: Response) => {
  const actor = req.authUser;
  const id = String(req.params.id || "");
  const body = sanitizeText(req.body?.body, 3000);

  if (!body || body.length < 2) {
    return res.status(400).json({
      error: { code: "INVALID_NOTE", message: "Note content must be at least 2 characters." },
    });
  }

  try {
    const existing = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Lead not found." } });
    }

    const result = await prisma.$transaction(async (tx) => {
      const note = await tx.leadNote.create({
        data: {
          leadId: id,
          authorId: actor.id,
          body,
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, role: true, avatarUrl: true },
          },
        },
      });

      await tx.leadStatusChange.create({
        data: {
          leadId: id,
          eventType: "NOTE_ADDED",
          fromStatus: existing.status,
          toStatus: existing.status,
          actorId: actor.id,
          details: `Internal note added by ${actor.name}`,
        },
      });

      return note;
    });

    return res.status(201).json({ success: true, note: result });
  } catch (error) {
    console.error("[Admin:Leads:AddNote] Error:", error);
    return res.status(500).json({ error: { message: "Failed to save internal note." } });
  }
});

// 3H. DELETE LEAD PERMANENTLY
adminLeadsRouter.delete("/:id", async (req: AdminAuthRequest, res: Response) => {
  const actor = req.authUser;
  const id = String(req.params.id || "");

  try {
    const existing = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, name: true, email: true },
    });

    if (!existing) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Lead not found." } });
    }

    await prisma.lead.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: "LEAD_DELETED",
        entity: "Lead",
        entityId: id,
        meta: { name: existing.name, email: existing.email },
      },
    }).catch(() => {});

    return res.json({ success: true, deleted: true, id });
  } catch (error) {
    console.error("[Admin:Leads:Delete] Error:", error);
    return res.status(500).json({ error: { message: "Failed to delete lead." } });
  }
});
