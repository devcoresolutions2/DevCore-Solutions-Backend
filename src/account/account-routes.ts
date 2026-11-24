import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../server/db/prisma";
import { hashPassword, verifyPassword, hashToken } from "../security/hash";
import { checkRateLimit } from "../security/rate-limit";
import {
  generateAvatarUploadSignature,
  verifyAndBuildAvatarResult,
  deleteFromCloudinary,
} from "../services/media.service";

export const accountRouter = Router();

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

export async function recordAuthEvent(params: {
  type: string;
  status?: "SUCCESS" | "FAILED";
  userId?: string | null;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, any>;
}) {
  try {
    await prisma.authEvent.create({
      data: {
        type: params.type,
        status: params.status || "SUCCESS",
        userId: params.userId ?? null,
        email: params.email ?? null,
        ip: params.ip ? String(params.ip).slice(0, 64) : null,
        userAgent: params.userAgent ? String(params.userAgent).slice(0, 255) : null,
        metadata: params.metadata ?? undefined,
      },
    });
  } catch (err) {
    console.error("[Audit] Failed to record AuthEvent:", err);
  }
}

function parseUserAgent(ua: string | null | undefined): {
  browser: string;
  os: string;
  deviceType: "desktop" | "mobile" | "cli";
} {
  if (!ua) return { browser: "Unknown Client", os: "Unknown OS", deviceType: "desktop" };
  const lower = ua.toLowerCase();

  let os = "Unknown OS";
  if (lower.includes("windows")) os = "Windows";
  else if (lower.includes("mac os x") || lower.includes("macintosh")) os = "macOS";
  else if (lower.includes("iphone") || lower.includes("ipad") || lower.includes("ios")) os = "iOS";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("linux")) os = "Linux";

  let browser = "Unknown Browser";
  let deviceType: "desktop" | "mobile" | "cli" = "desktop";

  if (lower.includes("edg/")) browser = "Microsoft Edge";
  else if (lower.includes("chrome/") && !lower.includes("edg/")) browser = "Google Chrome";
  else if (lower.includes("firefox/")) browser = "Mozilla Firefox";
  else if (lower.includes("safari/") && !lower.includes("chrome/")) browser = "Safari";
  else if (lower.includes("curl") || lower.includes("powershell") || lower.includes("node")) {
    browser = "API / CLI Client";
    deviceType = "cli";
  }

  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) {
    if (deviceType !== "cli") deviceType = "mobile";
  }

  return { browser, os, deviceType };
}

interface AuthenticatedRequest extends Request {
  authUser?: any;
  authSession?: any;
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const cookies = parseCookies(req);
  const sessionToken =
    cookies["devcore_session"] || req.headers.authorization?.replace("Bearer ", "");

  if (!sessionToken) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Authentication required." },
    });
  }

  try {
    const tokenHash = hashToken(sessionToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.revokedAt || new Date() > session.expiresAt || !session.user.isActive) {
      return res.status(401).json({
        error: { code: "SESSION_INVALID", message: "Your session has expired or been revoked." },
      });
    }

    req.authUser = session.user;
    req.authSession = session;

    prisma.session
      .update({
        where: { id: session.id },
        data: { lastActiveAt: new Date() },
      })
      .catch(() => {});

    return next();
  } catch (err) {
    console.error("[Account:Auth] Error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to verify session." },
    });
  }
}

accountRouter.use(requireAuth);

// ─── 1. ACCOUNT OVERVIEW ─────────────────────────────────────────────────────
accountRouter.get("/overview", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;

  try {
    const [accounts, activeSessionsCount, recentEventsCount] = await Promise.all([
      prisma.account.findMany({
        where: { userId: user.id },
        select: {
          id: true,
          provider: true,
          providerAccountId: true,
          createdAt: true,
        },
      }),
      prisma.session.count({
        where: {
          userId: user.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
      prisma.authEvent.count({
        where: { userId: user.id },
      }),
    ]);

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        emailVerified: user.emailVerified,
        avatarUrl: user.avatarUrl,
        avatarPublicId: user.avatarPublicId,
        avatarVersion: user.avatarVersion,
        role: user.role,
        isActive: user.isActive,
        hasPassword: Boolean(user.passwordHash),
        lastSignInAt: user.lastSignInAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      providers: accounts.map((acc) => ({
        id: acc.id,
        provider: acc.provider,
        connectedAt: acc.createdAt,
      })),
      activeSessionsCount,
      recentEventsCount,
      oauthConfigured: {
        google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      },
    });
  } catch (error) {
    console.error("[Account:Overview] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load account overview." },
    });
  }
});

// ─── 2. UPDATE PROFILE ───────────────────────────────────────────────────────
accountRouter.patch("/profile", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const { name, username } = req.body;
  const ip = req.ip || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  if (!name || typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    return res.status(400).json({
      error: { code: "INVALID_NAME", message: "Full name must be between 2 and 80 characters." },
    });
  }

  let normalizedUsername: string | null = null;
  if (username !== undefined && username !== null && String(username).trim() !== "") {
    const clean = String(username).trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,30}$/.test(clean)) {
      return res.status(400).json({
        error: {
          code: "INVALID_USERNAME",
          message:
            "Username must be 3–30 characters and contain only lowercase letters, numbers, dots, underscores, or hyphens.",
        },
      });
    }
    normalizedUsername = clean;
  }

  try {
    if (normalizedUsername && normalizedUsername !== user.username) {
      const conflict = await prisma.user.findUnique({
        where: { username: normalizedUsername },
        select: { id: true },
      });
      if (conflict && conflict.id !== user.id) {
        return res.status(409).json({
          error: {
            code: "USERNAME_TAKEN",
            message: "That username is already in use by another account.",
          },
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: name.trim(),
        username: normalizedUsername,
      },
    });

    await recordAuthEvent({
      type: "PROFILE_UPDATED",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: ip ? String(ip) : null,
      userAgent,
      metadata: {
        nameUpdated: updated.name !== user.name,
        usernameUpdated: updated.username !== user.username,
      },
    });

    return res.json({
      success: true,
      message: "Profile information saved.",
      user: {
        id: updated.id,
        name: updated.name,
        username: updated.username,
        email: updated.email,
        emailVerified: updated.emailVerified,
        avatarUrl: updated.avatarUrl,
        avatarPublicId: updated.avatarPublicId,
        avatarVersion: updated.avatarVersion,
        role: updated.role,
        isActive: updated.isActive,
        hasPassword: Boolean(updated.passwordHash),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error) {
    console.error("[Account:Profile] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to update profile." },
    });
  }
});

// ─── 3. CLOUDINARY AVATAR SIGNED UPLOAD AUTHORIZATION ─────────────────────────
accountRouter.post("/avatar/signature", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const rate = await checkRateLimit(`avatar-sig:${user.id}`, 15, 600);
  if (!rate.allowed) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many avatar upload requests. Please wait before trying again.",
        retryAfter: rate.resetInSeconds,
      },
    });
  }

  try {
    const sigPayload = generateAvatarUploadSignature(user.id);
    return res.json(sigPayload);
  } catch (error: any) {
    console.error("[Account:AvatarSig] Error:", error);
    return res.status(500).json({
      error: {
        code: "CLOUDINARY_ERROR",
        message: error.message || "Failed to generate Cloudinary upload signature.",
      },
    });
  }
});

// ─── 4. CONFIRM CLOUDINARY AVATAR UPLOAD ─────────────────────────────────────
accountRouter.post("/avatar/confirm", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const { publicId } = req.body;
  const ip = req.ip || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  if (!publicId || typeof publicId !== "string") {
    return res.status(400).json({
      error: { code: "MISSING_PUBLIC_ID", message: "Cloudinary publicId is required." },
    });
  }

  try {
    const verified = await verifyAndBuildAvatarResult(publicId, user.id);
    const previousPublicId = user.avatarPublicId;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        avatarUrl: verified.url,
        avatarPublicId: verified.publicId,
        avatarVersion: verified.version ?? null,
      },
    });

    // Delete old Cloudinary asset only AFTER DB update succeeds
    if (previousPublicId && previousPublicId !== verified.publicId) {
      await deleteFromCloudinary(previousPublicId).catch((err) => {
        console.warn("[Account:AvatarConfirm] Failed to delete previous avatar:", err?.message);
      });
    }

    await recordAuthEvent({
      type: "AVATAR_UPLOADED",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: ip ? String(ip) : null,
      userAgent,
      metadata: {
        format: verified.format,
        bytes: verified.bytes,
        width: verified.width,
        height: verified.height,
      },
    });

    return res.json({
      success: true,
      message: "Profile image uploaded and optimized via Cloudinary.",
      avatarUrl: updated.avatarUrl,
      avatarPublicId: updated.avatarPublicId,
      avatarVersion: updated.avatarVersion,
    });
  } catch (error: any) {
    console.error("[Account:AvatarConfirm] Error:", error);
    return res.status(400).json({
      error: {
        code: "AVATAR_VERIFICATION_FAILED",
        message: error.message || "Failed to verify uploaded profile image.",
      },
    });
  }
});

// ─── 5. REMOVE AVATAR ────────────────────────────────────────────────────────
accountRouter.delete("/avatar", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const ip = req.ip || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;
  const previousPublicId = user.avatarPublicId;

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        avatarUrl: null,
        avatarPublicId: null,
        avatarVersion: null,
      },
    });

    if (previousPublicId) {
      await deleteFromCloudinary(previousPublicId).catch((err) => {
        console.warn("[Account:AvatarDelete] Cloudinary destroy warning:", err?.message);
      });
    }

    await recordAuthEvent({
      type: "AVATAR_REMOVED",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: ip ? String(ip) : null,
      userAgent,
    });

    return res.json({
      success: true,
      message: "Profile image removed.",
    });
  } catch (error) {
    console.error("[Account:AvatarDelete] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to remove profile image." },
    });
  }
});

// ─── 6. CHANGE OR SET PASSWORD ───────────────────────────────────────────────
accountRouter.post("/password", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const currentSession = req.authSession;
  const { currentPassword, newPassword, revokeOtherSessions = true } = req.body;
  const ip = req.ip || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  const rate = await checkRateLimit(`pwd-change:${user.id}`, 8, 900);
  if (!rate.allowed) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many password change attempts. Please wait before trying again.",
        retryAfter: rate.resetInSeconds,
      },
    });
  }

  if (!newPassword || typeof newPassword !== "string") {
    return res.status(400).json({
      error: { code: "MISSING_PASSWORD", message: "New password is required." },
    });
  }

  // Unified password policy: 10–128 chars, letter, number, special character
  if (newPassword.length < 10 || newPassword.length > 128) {
    return res.status(400).json({
      error: {
        code: "WEAK_PASSWORD",
        message: "Password must be between 10 and 128 characters.",
      },
    });
  }

  const hasLetter = /[a-zA-Z]/.test(newPassword);
  const hasNumber = /[0-9]/.test(newPassword);
  const hasSpecial = /[^A-Za-z0-9]/.test(newPassword);

  if (!hasLetter || !hasNumber || !hasSpecial) {
    return res.status(400).json({
      error: {
        code: "WEAK_PASSWORD",
        message: "Password must contain at least one letter, one number, and one special character.",
      },
    });
  }

  try {
    const isInitialSetup = !user.passwordHash;

    if (!isInitialSetup) {
      if (!currentPassword || typeof currentPassword !== "string") {
        return res.status(400).json({
          error: {
            code: "CURRENT_PASSWORD_REQUIRED",
            message: "Please enter your current password.",
          },
        });
      }

      const validCurrent = await verifyPassword(currentPassword, user.passwordHash);
      if (!validCurrent) {
        await recordAuthEvent({
          type: "PASSWORD_CHANGE_FAILED",
          status: "FAILED",
          userId: user.id,
          email: user.email,
          ip: ip ? String(ip) : null,
          userAgent,
          metadata: { reason: "incorrect_current_password" },
        });
        return res.status(401).json({
          error: {
            code: "INVALID_CURRENT_PASSWORD",
            message: "Current password is incorrect.",
          },
        });
      }
    }

    const newHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    let revokedOthersCount = 0;
    if (revokeOtherSessions) {
      const revoked = await prisma.session.updateMany({
        where: {
          userId: user.id,
          id: { not: currentSession.id },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      revokedOthersCount = revoked.count;
    }

    await recordAuthEvent({
      type: isInitialSetup ? "PASSWORD_SET" : "PASSWORD_CHANGED",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: ip ? String(ip) : null,
      userAgent,
      metadata: { revokedOthersCount },
    });

    return res.json({
      success: true,
      message: isInitialSetup
        ? "Local password has been configured for your account."
        : "Password updated successfully.",
      revokedOthersCount,
    });
  } catch (error) {
    console.error("[Account:Password] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to update password." },
    });
  }
});

// ─── 7. CONNECTED PROVIDERS ──────────────────────────────────────────────────
accountRouter.get("/providers", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;

  try {
    const accounts = await prisma.account.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        provider: true,
        providerAccountId: true,
        createdAt: true,
      },
    });

    return res.json({
      hasPassword: Boolean(user.passwordHash),
      email: user.email,
      providers: accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        connectedAt: a.createdAt,
      })),
    });
  } catch (error) {
    console.error("[Account:Providers] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load connected providers." },
    });
  }
});

accountRouter.delete("/providers/:provider", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const provider = String(req.params.provider || "").toLowerCase();
  const ip = req.ip || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  if (!["google", "github"].includes(provider)) {
    return res.status(400).json({
      error: { code: "INVALID_PROVIDER", message: "Unsupported provider." },
    });
  }

  try {
    const accounts = await prisma.account.findMany({
      where: { userId: user.id },
    });

    const target = accounts.find((a) => a.provider.toLowerCase() === provider);
    if (!target) {
      return res.status(404).json({
        error: { code: "NOT_CONNECTED", message: `${provider} is not connected to this account.` },
      });
    }

    const otherProvidersCount = accounts.filter((a) => a.provider.toLowerCase() !== provider).length;
    const hasPassword = Boolean(user.passwordHash);

    if (!hasPassword && otherProvidersCount === 0) {
      return res.status(400).json({
        error: {
          code: "LOCKOUT_PREVENTED",
          message:
            "Cannot disconnect your only sign-in method. Please set a local password or link another provider first.",
        },
      });
    }

    await prisma.account.delete({ where: { id: target.id } });

    await recordAuthEvent({
      type: "PROVIDER_DISCONNECTED",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: ip ? String(ip) : null,
      userAgent,
      metadata: { provider },
    });

    return res.json({
      success: true,
      message: `${provider === "google" ? "Google" : "GitHub"} provider disconnected.`,
    });
  } catch (error) {
    console.error("[Account:ProviderDelete] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to disconnect provider." },
    });
  }
});

// ─── 8. ACTIVE SESSIONS ──────────────────────────────────────────────────────
accountRouter.get("/sessions", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const currentSession = req.authSession;

  try {
    const sessions = await prisma.session.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastActiveAt: "desc" },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        approxLocation: true,
        rememberMe: true,
        lastActiveAt: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    return res.json({
      sessions: sessions.map((s) => {
        const parsed = parseUserAgent(s.userAgent);
        return {
          id: s.id,
          isCurrent: s.id === currentSession.id,
          browser: parsed.browser,
          os: parsed.os,
          deviceType: parsed.deviceType,
          ip: s.ip,
          approxLocation: s.approxLocation,
          rememberMe: s.rememberMe,
          lastActiveAt: s.lastActiveAt,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
        };
      }),
    });
  } catch (error) {
    console.error("[Account:Sessions] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to retrieve active sessions." },
    });
  }
});

accountRouter.delete("/sessions/:sessionId", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const currentSession = req.authSession;
  const sessionId = String(req.params.sessionId || "");
  const ip = req.ip || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  if (sessionId === currentSession.id) {
    return res.status(400).json({
      error: {
        code: "CANNOT_REVOKE_CURRENT",
        message: "Use Sign Out to terminate your current active session.",
      },
    });
  }

  try {
    const target = await prisma.session.findFirst({
      where: {
        id: sessionId,
        userId: user.id,
        revokedAt: null,
      },
    });

    if (!target) {
      return res.status(404).json({
        error: { code: "SESSION_NOT_FOUND", message: "Session not found or already revoked." },
      });
    }

    await prisma.session.update({
      where: { id: target.id },
      data: { revokedAt: new Date() },
    });

    await recordAuthEvent({
      type: "SESSION_REVOKED",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: ip ? String(ip) : null,
      userAgent,
      metadata: { revokedSessionId: target.id },
    });

    return res.json({
      success: true,
      message: "Session revoked successfully.",
    });
  } catch (error) {
    console.error("[Account:RevokeSession] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to revoke session." },
    });
  }
});

accountRouter.post("/sessions/revoke-others", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const currentSession = req.authSession;
  const ip = req.ip || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  try {
    const result = await prisma.session.updateMany({
      where: {
        userId: user.id,
        id: { not: currentSession.id },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    await recordAuthEvent({
      type: "OTHER_SESSIONS_REVOKED",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: ip ? String(ip) : null,
      userAgent,
      metadata: { revokedCount: result.count },
    });

    return res.json({
      success: true,
      revokedCount: result.count,
      message: `Revoked ${result.count} other active session(s).`,
    });
  } catch (error) {
    console.error("[Account:RevokeOthers] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to revoke other sessions." },
    });
  }
});

// ─── 9. SECURITY AUDIT EVENTS ────────────────────────────────────────────────
accountRouter.get("/audit-events", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
  const skip = (page - 1) * limit;

  try {
    const [events, total] = await Promise.all([
      prisma.authEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          status: true,
          ip: true,
          userAgent: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.authEvent.count({ where: { userId: user.id } }),
    ]);

    return res.json({
      events: events.map((ev) => ({
        id: ev.id,
        type: ev.type,
        status: ev.status,
        ip: ev.ip,
        client: parseUserAgent(ev.userAgent),
        metadata: ev.metadata,
        createdAt: ev.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error("[Account:AuditEvents] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load security audit events." },
    });
  }
});

accountRouter.get("/audit-events/export", async (req: AuthenticatedRequest, res: Response) => {
  const user = req.authUser;

  try {
    const events = await prisma.authEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        type: true,
        status: true,
        ip: true,
        metadata: true,
        createdAt: true,
      },
    });

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="devcore-security-audit-${user.id}.json"`
    );
    return res.send(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          userId: user.id,
          email: user.email,
          count: events.length,
          events,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("[Account:AuditExport] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to export security events." },
    });
  }
});
