import { Request, Response, NextFunction } from "express";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../server/db/prisma";
import { hashToken } from "./hash";

export interface AuthenticatedAdminRequest extends Request {
  authUser?: {
    id: string;
    email: string;
    name: string;
    role: string;
    avatarUrl?: string | null;
  };
}

export function parseCookies(req: Request): Record<string, string> {
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

export function requireAdminSession(
  allowedRoles: Array<"SUPER_ADMIN" | "EDITOR"> = ["SUPER_ADMIN", "EDITOR"],
) {
  return async (req: AuthenticatedAdminRequest, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req);
    const sessionToken =
      cookies["devcore_session"] || req.headers.authorization?.replace("Bearer ", "");

    if (!sessionToken) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." },
      });
    }

    try {
      const session = await prisma.session.findUnique({
        where: { tokenHash: hashToken(sessionToken) },
        include: { user: true },
      });

      if (
        !session ||
        session.revokedAt ||
        new Date() > session.expiresAt ||
        !session.user.isActive
      ) {
        return res.status(401).json({
          error: { code: "SESSION_INVALID", message: "Session expired or revoked." },
        });
      }

      if (!allowedRoles.includes(session.user.role as any)) {
        // Record access denial in AuditLog
        await prisma.auditLog
          .create({
            data: {
              actorId: session.user.id,
              action: "ACCESS_DENIED",
              entity: "AdminRoute",
              entityId: req.originalUrl.slice(0, 120),
              meta: {
                requiredRoles: allowedRoles,
                userRole: session.user.role,
                result: "DENIED",
              } as Prisma.InputJsonValue,
              ip: req.ip || req.socket?.remoteAddress || null,
            },
          })
          .catch(() => {});

        return res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to access this resource.",
          },
        });
      }

      req.authUser = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
        avatarUrl: session.user.avatarUrl,
      };
      next();
    } catch (err) {
      console.error("Admin session middleware error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Authorization check failed." },
      });
    }
  };
}

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "accesstoken",
  "refreshtoken",
  "token",
  "tokenhash",
  "secret",
  "secretencrypted",
  "plaintextsecret",
  "otp",
  "apikey",
  "encryptionkey",
]);

export function sanitizeAuditMeta(obj: unknown, depth = 0): unknown {
  if (depth > 4 || obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 50).map((x) => sanitizeAuditMeta(x, depth + 1));
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeAuditMeta(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

export async function recordAdminAudit(params: {
  actorId: string;
  action: string;
  entity: string;
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
        meta: sanitizeAuditMeta(params.meta || {}) as Prisma.InputJsonValue,
        ip: params.req?.ip || params.req?.socket?.remoteAddress || null,
      },
    });
  } catch (err) {
    console.error("AuditLog write error:", err);
  }
}

/**
 * Escapes CSV cell values and neutralizes spreadsheet formula injection (=, +, -, @, \t, \r).
 */
export function escapeCsvCell(value: unknown): string {
  let str = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
