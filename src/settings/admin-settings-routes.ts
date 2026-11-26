import { Router, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../server/db/prisma";
import {
  AuthenticatedAdminRequest,
  recordAdminAudit,
  requireAdminSession,
} from "../security/admin-middleware";
import { verifySmtpConnectivity } from "../emails/mailer";
import { BRANDING_LOGOS } from "../services/media.service";

export const adminSettingsRouter = Router();
export const publicSettingsRouter = Router();

const DEFAULT_BUSINESS_HOURS = {
  monday: { isOpen: true, start: "09:00", end: "18:00" },
  tuesday: { isOpen: true, start: "09:00", end: "18:00" },
  wednesday: { isOpen: true, start: "09:00", end: "18:00" },
  thursday: { isOpen: true, start: "09:00", end: "18:00" },
  friday: { isOpen: true, start: "09:00", end: "17:00" },
  saturday: { isOpen: false, start: "09:00", end: "13:00" },
  sunday: { isOpen: false, start: "09:00", end: "13:00" },
};

async function getOrCreateSettings() {
  const existing = await prisma.contactSettings.findUnique({
    where: { id: "singleton" },
  });
  if (existing) return existing;

  return await prisma.contactSettings.create({
    data: {
      id: "singleton",
      organizationName: "DevCore Solutions",
      whatsappNumber: "",
      phone: "",
      publicEmail: process.env.SMTP_USER || "",
      notifyEmails: [],
      timezone: "Asia/Dhaka",
      businessHours: DEFAULT_BUSINESS_HOURS as Prisma.InputJsonValue,
      afterHoursPolicy: "NEXT_BUSINESS_DAY",
      socialLinks: [],
      seoDefaults: {
        defaultTitle: "DevCore Solutions | Systems Engineering & Cloud Architecture",
        titleSuffix: " | DevCore Solutions",
        defaultDescription:
          "Enterprise software engineering, distributed backend architecture, and full-stack web platforms.",
        canonicalBaseUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
        robotsPolicy: "index, follow",
        ogTitle: "DevCore Solutions",
        ogDescription:
          "Enterprise software engineering and cloud architecture.",
        ogImageUrl: BRANDING_LOGOS.light,
        twitterCardType: "summary_large_image",
      } as Prisma.InputJsonValue,
      brandAssets: {
        organizationName: "DevCore Solutions",
        logoLightUrl: BRANDING_LOGOS.light,
        logoDarkUrl: BRANDING_LOGOS.dark,
        faviconUrl: BRANDING_LOGOS.light,
        logoAlt: "DevCore Solutions Logo",
      } as Prisma.InputJsonValue,
    },
  });
}

// ─── PUBLIC SETTINGS ENDPOINT (CONSUMED BY PUBLIC SITE) ───────────────────────

publicSettingsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const s = await getOrCreateSettings();
    return res.json({
      organizationName: s.organizationName || "DevCore Solutions",
      publicEmail: s.publicEmail,
      phone: s.phone,
      whatsappNumber: s.whatsappNumber,
      bookingUrl: s.bookingUrl,
      timezone: s.timezone,
      businessHours: s.businessHours,
      afterHoursPolicy: s.afterHoursPolicy,
      socialLinks: Array.isArray(s.socialLinks)
        ? (s.socialLinks as any[]).filter((l) => l && l.isEnabled !== false && l.url)
        : [],
      seoDefaults: s.seoDefaults || {},
      brandAssets: s.brandAssets || {
        logoLightUrl: BRANDING_LOGOS.light,
        logoDarkUrl: BRANDING_LOGOS.dark,
      },
    });
  } catch (err) {
    console.error("Public settings error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load settings." } });
  }
});

// ─── ADMIN SETTINGS ───────────────────────────────────────────────────────────

adminSettingsRouter.use(requireAdminSession(["SUPER_ADMIN", "EDITOR"]));

adminSettingsRouter.get("/", async (_req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const settings = await getOrCreateSettings();
    return res.json({ settings });
  } catch (err) {
    console.error("Get admin settings error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load settings." } });
  }
});

adminSettingsRouter.put(
  "/",
  requireAdminSession(["SUPER_ADMIN"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    try {
      const current = await getOrCreateSettings();
      const body = req.body || {};

      const timezone =
        typeof body.timezone === "string" && body.timezone.trim()
          ? body.timezone.trim()
          : current.timezone;

      // Validate IANA timezone
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        return res.status(400).json({
          error: { code: "INVALID_TIMEZONE", message: `Invalid IANA timezone: ${timezone}` },
        });
      }

      const publicEmail =
        typeof body.publicEmail === "string" ? body.publicEmail.trim() : current.publicEmail;
      if (publicEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(publicEmail)) {
        return res.status(400).json({
          error: { code: "INVALID_EMAIL", message: "Invalid public email format." },
        });
      }

      const bookingUrl =
        typeof body.bookingUrl === "string" ? body.bookingUrl.trim() || null : current.bookingUrl;
      if (bookingUrl) {
        try {
          new URL(bookingUrl);
        } catch {
          return res.status(400).json({
            error: { code: "INVALID_URL", message: "Booking URL must be a valid URL." },
          });
        }
      }

      const updated = await prisma.contactSettings.update({
        where: { id: "singleton" },
        data: {
          organizationName:
            typeof body.organizationName === "string"
              ? body.organizationName.trim().slice(0, 120)
              : current.organizationName,
          publicEmail,
          phone: typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : current.phone,
          whatsappNumber:
            typeof body.whatsappNumber === "string"
              ? body.whatsappNumber.trim().slice(0, 40)
              : current.whatsappNumber,
          bookingUrl,
          timezone,
          businessHours: (body.businessHours ?? current.businessHours) as Prisma.InputJsonValue,
          afterHoursPolicy:
            body.afterHoursPolicy === "ON_CALL_WARNING" ? "ON_CALL_WARNING" : "NEXT_BUSINESS_DAY",
          incidentContact:
            typeof body.incidentContact === "string"
              ? body.incidentContact.trim().slice(0, 120) || null
              : current.incidentContact,
          secureMessagingContact:
            typeof body.secureMessagingContact === "string"
              ? body.secureMessagingContact.trim().slice(0, 120) || null
              : current.secureMessagingContact,
          socialLinks: (body.socialLinks ?? current.socialLinks ?? []) as Prisma.InputJsonValue,
          seoDefaults: (body.seoDefaults ?? current.seoDefaults ?? {}) as Prisma.InputJsonValue,
          brandAssets: (body.brandAssets ?? current.brandAssets ?? {}) as Prisma.InputJsonValue,
          updatedById: req.authUser!.id,
        },
      });

      await recordAdminAudit({
        actorId: req.authUser!.id,
        action: "PLATFORM_SETTINGS_UPDATED",
        entity: "ContactSettings",
        entityId: "singleton",
        meta: {
          organizationName: updated.organizationName,
          timezone: updated.timezone,
          afterHoursPolicy: updated.afterHoursPolicy,
        },
        req,
      });

      return res.json({ settings: updated });
    } catch (err) {
      console.error("Update admin settings error:", err);
      return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to save settings." } });
    }
  },
);

// ─── REAL INTEGRATION HEALTH CHECKS ───────────────────────────────────────────

adminSettingsRouter.post("/health-check", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const checkedAt = new Date().toISOString();

    // 1. PostgreSQL / Neon check
    const dbStart = Date.now();
    let dbStatus: { status: string; latencyMs: number | null; error: string | null } = {
      status: "HEALTHY",
      latencyMs: null,
      error: null,
    };
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus.latencyMs = Date.now() - dbStart;
    } catch (err: any) {
      dbStatus = {
        status: "ERROR",
        latencyMs: Date.now() - dbStart,
        error: err?.message ? String(err.message).slice(0, 150) : "DB query failed",
      };
    }

    // 2. SMTP check
    const smtp = await verifySmtpConnectivity();

    // 3. Cloudinary check
    const cloudStart = Date.now();
    let cloudStatus: { status: string; latencyMs: number | null; error: string | null } = {
      status: "NOT_CONFIGURED",
      latencyMs: null,
      error: null,
    };
    const cloudCfg = cloudinary.config();
    if (cloudCfg.cloud_name && cloudCfg.api_key && cloudCfg.api_secret) {
      try {
        await cloudinary.api.ping();
        cloudStatus = { status: "HEALTHY", latencyMs: Date.now() - cloudStart, error: null };
      } catch (err: any) {
        cloudStatus = {
          status: "ERROR",
          latencyMs: Date.now() - cloudStart,
          error: err?.message ? String(err.message).slice(0, 150) : "Cloudinary ping failed",
        };
      }
    }

    // 4. Google OAuth & Gemini AI env checks (no secrets exposed)
    const googleConfigured = Boolean(
      process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim(),
    );
    const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
    const connectedSocialCount = await prisma.socialConnection.count({ where: { isActive: true } });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "INTEGRATION_HEALTH_CHECKED",
      entity: "System",
      entityId: "INTEGRATIONS",
      meta: { db: dbStatus.status, smtp: smtp.ok, cloudinary: cloudStatus.status },
      req,
    });

    return res.json({
      checkedAt,
      integrations: [
        {
          key: "postgresql",
          name: "Neon PostgreSQL",
          category: "Database",
          status: dbStatus.status,
          latencyMs: dbStatus.latencyMs,
          detail: dbStatus.error || "Prisma connection pool active",
        },
        {
          key: "smtp",
          name: "SMTP Mail Service",
          category: "Email",
          status: !smtp.configured ? "NOT_CONFIGURED" : smtp.ok ? "HEALTHY" : "ERROR",
          latencyMs: smtp.latencyMs,
          detail: smtp.error || "Transporter verified",
        },
        {
          key: "cloudinary",
          name: "Cloudinary Media",
          category: "Storage & Delivery",
          status: cloudStatus.status,
          latencyMs: cloudStatus.latencyMs,
          detail: cloudStatus.error || `Cloud: ${cloudCfg.cloud_name || "configured"}`,
        },
        {
          key: "google_oauth",
          name: "Google OAuth",
          category: "Authentication",
          status: googleConfigured ? "CONFIGURED" : "NOT_CONFIGURED",
          latencyMs: null,
          detail: googleConfigured
            ? "Client ID & secret present in server env"
            : "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET",
        },
        {
          key: "gemini_ai",
          name: "Gemini AI",
          category: "Copy Adaptation",
          status: geminiConfigured ? "CONFIGURED" : "NOT_CONFIGURED",
          latencyMs: null,
          detail: geminiConfigured ? "GEMINI_API_KEY present" : "Missing GEMINI_API_KEY",
        },
        {
          key: "social_channels",
          name: "Social OAuth Relays",
          category: "Syndication",
          status: connectedSocialCount > 0 ? "CONNECTED" : "DISCONNECTED",
          latencyMs: null,
          detail: `${connectedSocialCount} active channel connection(s)`,
        },
      ],
    });
  } catch (err) {
    console.error("Settings health check error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Health check failed." } });
  }
});
