import { Router, Request, Response } from "express";
import type { ApplicationStatus, JobStatus } from "../generated/prisma/enums";
import { prisma } from "../server/db/prisma";
import {
  AuthenticatedAdminRequest,
  recordAdminAudit,
  requireAdminSession,
} from "../security/admin-middleware";

export const publicJobsRouter = Router();
export const adminApplicationsRouter = Router();
export const adminJobsRouter = Router();

adminApplicationsRouter.use(requireAdminSession(["SUPER_ADMIN", "EDITOR"]));
adminJobsRouter.use(requireAdminSession(["SUPER_ADMIN", "EDITOR"]));

const VALID_APPLICATION_STATUSES: ApplicationStatus[] = [
  "NEW",
  "REVIEWING",
  "INTERVIEW",
  "REJECTED",
  "HIRED",
];
const VALID_JOB_STATUSES: JobStatus[] = ["OPEN", "CLOSED"];

function slugifyDiscipline(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general-engineering"
  );
}

// ─── PUBLIC CAREERS ROUTES ────────────────────────────────────────────────────

publicJobsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const jobs = await prisma.job.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: jobs });
  } catch (err) {
    console.error("Failed to fetch public jobs:", err);
    res.status(500).json({ error: { message: "Failed to load open roles." } });
  }
});

publicJobsRouter.post("/apply", async (req: Request, res: Response) => {
  try {
    const {
      jobId,
      jobTitle,
      name,
      email,
      phone,
      resumePublicId,
      portfolioUrl,
      message,
    } = req.body ?? {};

    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!cleanName) {
      return res.status(400).json({ error: { message: "Full name is required." } });
    }
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: { message: "A valid email address is required." } });
    }

    const rawJobRef = typeof jobId === "string" ? jobId.trim() : "";
    let job = rawJobRef
      ? await prisma.job.findFirst({
          where: {
            OR: [{ id: rawJobRef }, { slug: rawJobRef }],
            deletedAt: null,
          },
        })
      : null;

    if (!job) {
      const fallbackSlug = slugifyDiscipline(
        rawJobRef || (typeof jobTitle === "string" ? jobTitle : "general-engineering")
      );
      const fallbackTitle =
        typeof jobTitle === "string" && jobTitle.trim()
          ? jobTitle.trim()
          : rawJobRef || "Engineering Candidacy";

      job = await prisma.job.upsert({
        where: { slug: fallbackSlug },
        update: { deletedAt: null },
        create: {
          slug: fallbackSlug,
          title: fallbackTitle,
          department: "Engineering",
          location: "Dhaka / Remote",
          type: "Full-time",
          description: `Open engineering candidacy for ${fallbackTitle}.`,
          status: "OPEN",
        },
      });
    }

    const cleanPhone = typeof phone === "string" ? phone.trim() : "";
    const cleanMessage = typeof message === "string" ? message.trim() : "";
    const combinedMessage = [
      cleanMessage,
      cleanPhone ? `Phone: ${cleanPhone}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const cleanPortfolio =
      typeof portfolioUrl === "string" && portfolioUrl.trim() ? portfolioUrl.trim() : null;
    const cleanResume =
      typeof resumePublicId === "string" && resumePublicId.trim()
        ? resumePublicId.trim()
        : "resume_uploaded";

    const application = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        name: cleanName,
        email: cleanEmail,
        resumePublicId: cleanResume,
        portfolioUrl: cleanPortfolio,
        message: combinedMessage || null,
        status: "NEW",
      },
    });

    res.status(201).json({
      data: {
        id: application.id,
        message: "Application received successfully.",
      },
    });
  } catch (err) {
    console.error("Failed to submit job application:", err);
    res.status(500).json({ error: { message: "Failed to submit application." } });
  }
});

publicJobsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "");
    const job = await prisma.job.findFirst({
      where: {
        OR: [{ id }, { slug: id }],
        deletedAt: null,
      },
    });
    if (!job) {
      return res.status(404).json({ error: { message: "Job not found" } });
    }
    res.json({ data: job });
  } catch (err) {
    console.error("Failed to fetch job detail:", err);
    res.status(500).json({ error: { message: "Failed to load job details." } });
  }
});

// ─── ADMIN CAREERS ROUTES ─────────────────────────────────────────────────────

adminApplicationsRouter.get("/", async (_req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const applications = await prisma.jobApplication.findMany({
      include: {
        job: { select: { id: true, title: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = applications.map((app) => ({
      id: app.id,
      jobId: app.jobId,
      jobTitle: app.job.title,
      name: app.name,
      email: app.email,
      resumeFileName: app.resumePublicId,
      portfolioUrl: app.portfolioUrl,
      message: app.message,
      status: app.status,
      createdAt: app.createdAt.toISOString(),
    }));

    res.json({ data });
  } catch (err) {
    console.error("Failed to fetch applications:", err);
    res.status(500).json({ error: { message: "Failed to load applications." } });
  }
});

adminApplicationsRouter.patch("/:id/status", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const id = String(req.params.id || "");
    const status = req.body?.status as ApplicationStatus;

    if (!VALID_APPLICATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: { message: "Invalid application status." } });
    }

    const updated = await prisma.jobApplication.update({
      where: { id },
      data: { status },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "APPLICATION_STATUS_UPDATED",
      entity: "JobApplication",
      entityId: id,
      meta: { status },
      req,
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Failed to update application status:", err);
    res.status(500).json({ error: { message: "Failed to update application status." } });
  }
});

adminJobsRouter.patch("/:id/status", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const id = String(req.params.id || "");
    const status = req.body?.status as JobStatus;

    if (!VALID_JOB_STATUSES.includes(status)) {
      return res.status(400).json({ error: { message: "Invalid job status." } });
    }

    const updated = await prisma.job.update({
      where: { id },
      data: { status },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "JOB_STATUS_UPDATED",
      entity: "Job",
      entityId: id,
      meta: { status },
      req,
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Failed to update job status:", err);
    res.status(500).json({ error: { message: "Failed to update job status." } });
  }
});
