import crypto from "node:crypto";
import { Router, Response } from "express";
import type { Prisma } from "../generated/prisma/client";
import type { Role } from "../generated/prisma/enums";
import { prisma } from "../server/db/prisma";
import { hashToken } from "../security/hash";
import {
  AuthenticatedAdminRequest,
  escapeCsvCell,
  recordAdminAudit,
  requireAdminSession,
} from "../security/admin-middleware";
import { sendAdminInvitationEmail, sendVerificationEmail } from "../emails/mailer";

export const adminUsersRouter = Router();

const VALID_ROLES: Role[] = ["USER", "CLIENT", "EDITOR", "SUPER_ADMIN"];

const ROLE_PERMISSIONS: Record<Role, string[]> = {
  SUPER_ADMIN: [
    "users.read",
    "users.invite",
    "users.change_role",
    "users.deactivate",
    "users.revoke_sessions",
    "audit.read",
    "audit.export",
    "settings.manage",
    "content.manage",
    "social.manage",
    "leads.manage",
  ],
  EDITOR: ["content.manage", "social.manage", "leads.manage", "media.manage"],
  CLIENT: ["portal.read"],
  USER: ["account.self"],
};

adminUsersRouter.use(requireAdminSession(["SUPER_ADMIN", "EDITOR"]));

// ─── LIST USERS, STATS, INVITATIONS ───────────────────────────────────────────

adminUsersRouter.get("/", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "10"), 10) || 10));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const roleFilter = typeof req.query.role === "string" ? req.query.role.toUpperCase() : "ALL";
    const statusFilter = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL";

    const where: Prisma.UserWhereInput = {};
    if (roleFilter !== "ALL" && VALID_ROLES.includes(roleFilter as Role)) {
      where.role = roleFilter as Role;
    }
    if (statusFilter === "ACTIVE") {
      where.isActive = true;
      where.emailVerified = true;
    } else if (statusFilter === "PENDING_VERIFICATION") {
      where.isActive = true;
      where.emailVerified = false;
    } else if (statusFilter === "DEACTIVATED") {
      where.isActive = false;
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const [
      total,
      users,
      totalUsersCount,
      pendingVerificationCount,
      activeTodayEvents,
      pendingInvitations,
    ] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          avatarUrl: true,
          role: true,
          isActive: true,
          emailVerified: true,
          lastSignInAt: true,
          createdAt: true,
          accounts: { select: { provider: true } },
          sessions: {
            where: { revokedAt: null, expiresAt: { gt: new Date() } },
            select: { id: true },
          },
        },
      }),
      prisma.user.count(),
      prisma.user.count({ where: { emailVerified: false, isActive: true } }),
      prisma.authEvent.findMany({
        where: {
          type: { in: ["LOGIN_SUCCESS", "OAUTH_LOGIN_SUCCESS"] },
          status: "SUCCESS",
          createdAt: { gte: startOfToday },
          userId: { not: null },
        },
        distinct: ["userId"],
        select: { userId: true },
      }),
      prisma.userInvitation.findMany({
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
    ]);

    return res.json({
      items: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl,
        role: u.role,
        permissions: ROLE_PERMISSIONS[u.role] || [],
        isActive: u.isActive,
        emailVerified: u.emailVerified,
        authProvider: u.accounts[0]?.provider || "email",
        lastLoginAt: u.lastSignInAt,
        createdAt: u.createdAt,
        activeSessionCount: u.sessions.length,
      })),
      pendingInvitations,
      stats: {
        totalUsers: totalUsersCount,
        activeToday: activeTodayEvents.length,
        pendingVerification: pendingVerificationCount,
        pendingInvitationsCount: pendingInvitations.length,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error("List admin users error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load users." } });
  }
});

// ─── EXPORT USER DIRECTORY CSV ────────────────────────────────────────────────

adminUsersRouter.get(
  "/export",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    try {
      const users = await prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 2000,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          emailVerified: true,
          lastSignInAt: true,
          createdAt: true,
          accounts: { select: { provider: true } },
        },
      });

      const headers = [
        "User ID",
        "Name",
        "Email",
        "Role",
        "Status",
        "Email Verified",
        "Auth Provider",
        "Last Sign-In (UTC)",
        "Created At (UTC)",
      ];

      const rows = users.map((u) =>
        [
          escapeCsvCell(u.id),
          escapeCsvCell(u.name),
          escapeCsvCell(u.email),
          escapeCsvCell(u.role),
          escapeCsvCell(u.isActive ? "ACTIVE" : "DEACTIVATED"),
          escapeCsvCell(u.emailVerified ? "VERIFIED" : "UNVERIFIED"),
          escapeCsvCell(u.accounts[0]?.provider || "email"),
          escapeCsvCell(u.lastSignInAt ? u.lastSignInAt.toISOString() : ""),
          escapeCsvCell(u.createdAt.toISOString()),
        ].join(","),
      );

      await recordAdminAudit({
        actorId: req.authUser!.id,
        action: "USER_DIRECTORY_EXPORTED",
        entity: "User",
        entityId: "EXPORT",
        meta: { count: users.length },
        req,
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="devcore-users-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.send([headers.join(","), ...rows].join("\r\n"));
    } catch (err) {
      console.error("User CSV export error:", err);
      return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Export failed." } });
    }
  },
);

// ─── USER DETAILS (SAFE PROFILE + SESSIONS + AUDIT) ───────────────────────────

adminUsersRouter.get("/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      role: true,
      isActive: true,
      emailVerified: true,
      lastSignInAt: true,
      createdAt: true,
      updatedAt: true,
      accounts: { select: { provider: true } },
      sessions: {
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: { id: true, ip: true, userAgent: true, expiresAt: true, createdAt: true },
      },
      authEvents: {
        orderBy: { createdAt: "desc" },
        take: 15,
        select: { id: true, type: true, status: true, ip: true, userAgent: true, createdAt: true },
      },
    },
  });

  if (!user) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
  }

  const auditLogs = await prisma.auditLog.findMany({
    where: { OR: [{ entity: "User", entityId: id }, { actorId: id }] },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return res.json({
    user: {
      ...user,
      authProvider: user.accounts[0]?.provider || "email",
      lastLoginAt: user.lastSignInAt,
      permissions: ROLE_PERMISSIONS[user.role] || [],
    },
    auditLogs,
  });
});

// ─── INVITE USER (SUPER_ADMIN ONLY) ───────────────────────────────────────────

adminUsersRouter.post(
  "/invite",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = (typeof req.body?.role === "string" ? req.body.role.toUpperCase() : "USER") as Role;
    const message =
      typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 500) : undefined;

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: { code: "INVALID_INPUT", message: "Valid name and email are required." },
      });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: { code: "INVALID_ROLE", message: "Invalid role." } });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({
        error: { code: "USER_EXISTS", message: "A user with this email already exists." },
      });
    }

    // Revoke prior pending invitations for this email
    await prisma.userInvitation.updateMany({
      where: { email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const invitation = await prisma.userInvitation.create({
      data: {
        email,
        name,
        role,
        tokenHash,
        message: message || null,
        invitedById: req.authUser!.id,
        expiresAt,
      },
    });

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
    const inviteUrl = `${appUrl}/auth/signup?invite=${rawToken}&email=${encodeURIComponent(email)}`;

    const sent = await sendAdminInvitationEmail({
      to: email,
      name,
      role,
      inviteUrl,
      inviterName: req.authUser!.name,
      message,
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "USER_INVITED",
      entity: "UserInvitation",
      entityId: invitation.id,
      meta: { email, role, emailDelivered: sent },
      req,
    });

    return res.status(201).json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
      emailDelivered: sent,
    });
  },
);

// ─── CHANGE ROLE (SUPER_ADMIN ONLY, LAST SUPER_ADMIN & SELF PROTECTED) ────────

adminUsersRouter.patch(
  "/:id/role",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    const id = String(req.params.id || "");
    const nextRole = (typeof req.body?.role === "string" ? req.body.role.toUpperCase() : "") as Role;

    if (!VALID_ROLES.includes(nextRole)) {
      return res.status(400).json({ error: { code: "INVALID_ROLE", message: "Invalid role." } });
    }
    if (id === req.authUser!.id) {
      return res.status(400).json({
        error: { code: "SELF_MUTATION_BLOCKED", message: "You cannot modify your own role." },
      });
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    }

    if (target.role === "SUPER_ADMIN" && nextRole !== "SUPER_ADMIN") {
      const superCount = await prisma.user.count({
        where: { role: "SUPER_ADMIN", isActive: true },
      });
      if (superCount <= 1) {
        return res.status(400).json({
          error: {
            code: "LAST_SUPER_ADMIN",
            message: "Cannot demote the last active SUPER_ADMIN.",
          },
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role: nextRole },
      select: { id: true, name: true, email: true, role: true },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "USER_ROLE_CHANGED",
      entity: "User",
      entityId: id,
      meta: { previousRole: target.role, newRole: nextRole, email: target.email },
      req,
    });

    return res.json({ user: updated });
  },
);

// ─── DEACTIVATE / REACTIVATE USER ─────────────────────────────────────────────

adminUsersRouter.post(
  "/:id/status",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    const id = String(req.params.id || "");
    const isActive = Boolean(req.body?.isActive);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";

    if (id === req.authUser!.id && !isActive) {
      return res.status(400).json({
        error: { code: "SELF_DEACTIVATE_BLOCKED", message: "You cannot deactivate yourself." },
      });
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    }

    if (!isActive && target.role === "SUPER_ADMIN") {
      const superCount = await prisma.user.count({
        where: { role: "SUPER_ADMIN", isActive: true },
      });
      if (superCount <= 1) {
        return res.status(400).json({
          error: {
            code: "LAST_SUPER_ADMIN",
            message: "Cannot deactivate the last active SUPER_ADMIN.",
          },
        });
      }
    }

    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: { isActive },
        select: { id: true, name: true, email: true, isActive: true },
      }),
      ...(!isActive
        ? [
            prisma.session.updateMany({
              where: { userId: id, revokedAt: null },
              data: { revokedAt: new Date() },
            }),
          ]
        : []),
    ]);

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: isActive ? "USER_REACTIVATED" : "USER_DEACTIVATED",
      entity: "User",
      entityId: id,
      meta: { email: target.email, reason: reason || undefined },
      req,
    });

    return res.json({ user: updated });
  },
);

// ─── REVOKE ALL SESSIONS ──────────────────────────────────────────────────────

adminUsersRouter.post(
  "/:id/revoke-sessions",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    const id = String(req.params.id || "");
    const result = await prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "SESSIONS_REVOKED",
      entity: "User",
      entityId: id,
      meta: { revokedCount: result.count },
      req,
    });

    return res.json({ revokedCount: result.count });
  },
);

// ─── RESEND EMAIL VERIFICATION ────────────────────────────────────────────────

adminUsersRouter.post(
  "/:id/resend-verification",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    const id = String(req.params.id || "");
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    }
    if (user.emailVerified) {
      return res.status(400).json({
        error: { code: "ALREADY_VERIFIED", message: "User email is already verified." },
      });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const otp = String(crypto.randomInt(100000, 999999));

    await prisma.verificationToken.create({
      data: {
        email: user.email,
        otpHash: hashToken(otp),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const delivered = await sendVerificationEmail(user.email, user.name, token, otp);

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "VERIFICATION_RESENT",
      entity: "User",
      entityId: id,
      meta: { email: user.email, delivered },
      req,
    });

    return res.json({ sent: delivered });
  },
);

// ─── BULK USER ACTIONS (SUPER_ADMIN ONLY) ─────────────────────────────────────

adminUsersRouter.post(
  "/bulk",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    const userIds: string[] = Array.isArray(req.body?.userIds)
      ? req.body.userIds.filter((x: unknown): x is string => typeof x === "string")
      : [];
    const action = typeof req.body?.action === "string" ? req.body.action.toUpperCase() : "";
    const role = (typeof req.body?.role === "string" ? req.body.role.toUpperCase() : "") as Role;

    if (userIds.length === 0) {
      return res.status(400).json({ error: { code: "INVALID_INPUT", message: "No users selected." } });
    }
    if (!["REVOKE_SESSIONS", "DEACTIVATE", "CHANGE_ROLE"].includes(action)) {
      return res.status(400).json({ error: { code: "INVALID_ACTION", message: "Unsupported bulk action." } });
    }
    if (action === "CHANGE_ROLE" && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: { code: "INVALID_ROLE", message: "Invalid target role." } });
    }

    const targets = await prisma.user.findMany({ where: { id: { in: userIds } } });
    let succeeded = 0;
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const target of targets) {
      if (target.id === req.authUser!.id && (action === "DEACTIVATE" || action === "CHANGE_ROLE")) {
        skipped.push({ id: target.id, reason: "Cannot modify your own account in bulk." });
        continue;
      }
      if (
        target.role === "SUPER_ADMIN" &&
        (action === "DEACTIVATE" || (action === "CHANGE_ROLE" && role !== "SUPER_ADMIN"))
      ) {
        const superCount = await prisma.user.count({
          where: { role: "SUPER_ADMIN", isActive: true },
        });
        if (superCount <= 1) {
          skipped.push({ id: target.id, reason: "Last active SUPER_ADMIN protected." });
          continue;
        }
      }

      if (action === "REVOKE_SESSIONS") {
        await prisma.session.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } else if (action === "DEACTIVATE") {
        await prisma.$transaction([
          prisma.user.update({ where: { id: target.id }, data: { isActive: false } }),
          prisma.session.updateMany({
            where: { userId: target.id, revokedAt: null },
            data: { revokedAt: new Date() },
          }),
        ]);
      } else if (action === "CHANGE_ROLE") {
        await prisma.user.update({ where: { id: target.id }, data: { role } });
      }
      succeeded += 1;
    }

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: `USER_BULK_${action}`,
      entity: "User",
      entityId: "BATCH",
      meta: { succeeded, skippedCount: skipped.length, role: role || undefined },
      req,
    });

    return res.json({ succeeded, skipped });
  },
);

// ─── DELETE USER PERMANENTLY (SUPER_ADMIN ONLY) ───────────────────────────────
adminUsersRouter.delete(
  "/:id",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    const targetId = String(req.params.id || "");

    if (targetId === req.authUser!.id) {
      return res.status(400).json({
        error: { code: "SELF_DELETE_BLOCKED", message: "You cannot delete your own account." },
      });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    if (!target) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    }

    if (target.role === "SUPER_ADMIN" && target.isActive) {
      const superCount = await prisma.user.count({
        where: { role: "SUPER_ADMIN", isActive: true },
      });
      if (superCount <= 1) {
        return res.status(400).json({
          error: {
            code: "LAST_SUPER_ADMIN",
            message: "Cannot delete the last active SUPER_ADMIN account.",
          },
        });
      }
    }

    await prisma.user.delete({ where: { id: targetId } });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "USER_DELETED",
      entity: "User",
      entityId: targetId,
      meta: { name: target.name, email: target.email, role: target.role },
      req,
    });

    return res.json({ deleted: true, id: targetId });
  },
);
