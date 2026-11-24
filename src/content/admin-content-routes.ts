import { Router, Response } from "express";
import type { TestimonialStatus } from "../generated/prisma/enums";
import { prisma } from "../server/db/prisma";
import {
  AuthenticatedAdminRequest,
  recordAdminAudit,
  requireAdminSession,
} from "../security/admin-middleware";

export const adminContentRouter = Router();

adminContentRouter.use(requireAdminSession(["SUPER_ADMIN", "EDITOR"]));

const VALID_TESTIMONIAL_STATUSES: TestimonialStatus[] = ["PENDING", "APPROVED", "REJECTED"];

// ─── CONTENT OPERATIONS OVERVIEW ──────────────────────────────────────────────

adminContentRouter.get("/overview", async (_req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const [
      publishedArticles,
      draftArticles,
      approvedTestimonials,
      pendingTestimonials,
      openJobs,
      pendingApplications,
      recentTestimonials,
      recentJobs,
      recentApplications,
    ] = await Promise.all([
      prisma.blogPost.count({ where: { status: "PUBLISHED", deletedAt: null } }),
      prisma.blogPost.count({ where: { status: "DRAFT", deletedAt: null } }),
      prisma.testimonial.count({ where: { status: "APPROVED", deletedAt: null } }),
      prisma.testimonial.count({ where: { status: "PENDING", deletedAt: null } }),
      prisma.job.count({ where: { status: "OPEN", deletedAt: null } }),
      prisma.jobApplication.count({ where: { status: { in: ["NEW", "REVIEWING"] } } }),
      prisma.testimonial.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.job.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { _count: { select: { applications: true } } },
      }),
      prisma.jobApplication.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { job: { select: { id: true, title: true } } },
      }),
    ]);

    return res.json({
      stats: {
        publishedArticles,
        draftArticles,
        approvedTestimonials,
        pendingTestimonials,
        openJobs,
        pendingApplications,
      },
      recentTestimonials,
      recentJobs,
      recentApplications,
    });
  } catch (err) {
    console.error("Content overview error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load content overview." } });
  }
});

// ─── TESTIMONIALS CRUD ────────────────────────────────────────────────────────

adminContentRouter.get("/testimonials", async (_req: AuthenticatedAdminRequest, res: Response) => {
  const items = await prisma.testimonial.findMany({
    where: { deletedAt: null },
    orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
  });
  return res.json({ items });
});

adminContentRouter.post("/testimonials", async (req: AuthenticatedAdminRequest, res: Response) => {
  const authorName =
    typeof req.body?.authorName === "string" ? req.body.authorName.trim().slice(0, 120) : "";
  const company =
    typeof req.body?.company === "string" ? req.body.company.trim().slice(0, 120) : null;
  const role = typeof req.body?.role === "string" ? req.body.role.trim().slice(0, 120) : null;
  const quote = typeof req.body?.quote === "string" ? req.body.quote.trim().slice(0, 2000) : "";
  const rating =
    typeof req.body?.rating === "number" && req.body.rating >= 1 && req.body.rating <= 5
      ? Math.round(req.body.rating)
      : null;
  const featured = Boolean(req.body?.featured);
  const statusRaw =
    typeof req.body?.status === "string" ? req.body.status.toUpperCase() : "PENDING";
  const status: TestimonialStatus = VALID_TESTIMONIAL_STATUSES.includes(
    statusRaw as TestimonialStatus,
  )
    ? (statusRaw as TestimonialStatus)
    : "PENDING";

  if (!authorName || !quote) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "Author name and quote are required." },
    });
  }

  const created = await prisma.testimonial.create({
    data: { authorName, company, role, quote, rating, featured, status },
  });

  await recordAdminAudit({
    actorId: req.authUser!.id,
    action: "TESTIMONIAL_CREATED",
    entity: "Testimonial",
    entityId: created.id,
    meta: { authorName, company, status },
    req,
  });

  return res.status(201).json({ testimonial: created });
});

adminContentRouter.patch("/testimonials/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.testimonial.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Testimonial not found." } });
  }

  const data: Record<string, any> = {};
  if (typeof req.body?.authorName === "string" && req.body.authorName.trim()) {
    data.authorName = req.body.authorName.trim().slice(0, 120);
  }
  if (typeof req.body?.company === "string") {
    data.company = req.body.company.trim().slice(0, 120) || null;
  }
  if (typeof req.body?.role === "string") {
    data.role = req.body.role.trim().slice(0, 120) || null;
  }
  if (typeof req.body?.quote === "string" && req.body.quote.trim()) {
    data.quote = req.body.quote.trim().slice(0, 2000);
  }
  if (typeof req.body?.featured === "boolean") {
    data.featured = req.body.featured;
  }
  if (typeof req.body?.status === "string") {
    const st = req.body.status.toUpperCase();
    if (VALID_TESTIMONIAL_STATUSES.includes(st as TestimonialStatus)) {
      data.status = st;
    }
  }

  const updated = await prisma.testimonial.update({ where: { id }, data });

  await recordAdminAudit({
    actorId: req.authUser!.id,
    action: "TESTIMONIAL_UPDATED",
    entity: "Testimonial",
    entityId: id,
    meta: { changedFields: Object.keys(data) },
    req,
  });

  return res.json({ testimonial: updated });
});

adminContentRouter.delete("/testimonials/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.testimonial.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Testimonial not found." } });
  }

  await prisma.testimonial.update({ where: { id }, data: { deletedAt: new Date() } });
  await recordAdminAudit({
    actorId: req.authUser!.id,
    action: "TESTIMONIAL_DELETED",
    entity: "Testimonial",
    entityId: id,
    meta: { authorName: existing.authorName },
    req,
  });

  return res.json({ deleted: true, id });
});

// ─── JSON CATALOG EXPORT ──────────────────────────────────────────────────────

adminContentRouter.get("/export", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const [blogPosts, testimonials, jobs] = await Promise.all([
      prisma.blogPost.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          slug: true,
          title: true,
          excerpt: true,
          tags: true,
          status: true,
          publishedAt: true,
          createdAt: true,
        },
      }),
      prisma.testimonial.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          authorName: true,
          company: true,
          role: true,
          quote: true,
          rating: true,
          status: true,
          featured: true,
          createdAt: true,
        },
      }),
      prisma.job.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          slug: true,
          title: true,
          department: true,
          location: true,
          type: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "CONTENT_CATALOG_EXPORTED",
      entity: "ContentCatalog",
      entityId: "EXPORT",
      meta: {
        blogPosts: blogPosts.length,
        testimonials: testimonials.length,
        jobs: jobs.length,
      },
      req,
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="devcore-content-catalog-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return res.send(
      JSON.stringify(
        { exportedAt: new Date().toISOString(), blogPosts, testimonials, jobs },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("Content catalog export error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Export failed." } });
  }
});

// ─── CREATE & DELETE SERVICES ─────────────────────────────────────────────────

adminContentRouter.post(
  "/services",
  requireAdminSession(["SUPER_ADMIN", "EDITOR"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    try {
      const { title, summary, deliverables, icon, displayOrder } = req.body || {};
      if (!title?.trim() || !summary?.trim()) {
        return res.status(400).json({
          error: { code: "INVALID_INPUT", message: "Service title and summary are required." },
        });
      }

      const baseSlug = String(title)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const existing = await prisma.service.findUnique({ where: { slug: baseSlug } });
      const slug = existing ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug || `service-${Date.now()}`;

      const deliverablesList = Array.isArray(deliverables)
        ? deliverables.map((d) => String(d).trim()).filter(Boolean)
        : String(deliverables || "")
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean);

      const service = await prisma.service.create({
        data: {
          slug,
          title: String(title).trim(),
          summary: String(summary).trim(),
          deliverables: deliverablesList,
          icon: String(icon || "Layers").trim() || "Layers",
          displayOrder: Number.isFinite(Number(displayOrder)) ? Number(displayOrder) : 0,
          visible: true,
          status: "PUBLISHED",
        },
      });

      await recordAdminAudit({
        actorId: req.authUser!.id,
        action: "SERVICE_CREATED",
        entity: "Service",
        entityId: service.id,
        meta: { title: service.title, slug: service.slug },
        req,
      });

      return res.status(201).json({ service });
    } catch (err) {
      console.error("Create service error:", err);
      return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create service." } });
    }
  },
);

adminContentRouter.delete(
  "/services/:id",
  requireAdminSession(["SUPER_ADMIN", "EDITOR"]),
  async (req: AuthenticatedAdminRequest, res: Response) => {
    try {
      const id = String(req.params.id || "");
      const existing = await prisma.service.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Service not found." } });
      }

      await prisma.service.delete({ where: { id } });

      await recordAdminAudit({
        actorId: req.authUser!.id,
        action: "SERVICE_DELETED",
        entity: "Service",
        entityId: id,
        meta: { title: existing.title },
        req,
      });

      return res.json({ deleted: true, id });
    } catch (err) {
      console.error("Delete service error:", err);
      return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete service." } });
    }
  },
);
