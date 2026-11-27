import { Router, Request, Response } from "express";
import type { ApplicationStatus, JobStatus } from "../generated/prisma/enums";
import { prisma } from "../server/db/prisma";
import {
  AuthenticatedAdminRequest,
  recordAdminAudit,
  requireAdminSession,
} from "../security/admin-middleware";
import {
  deleteResumeFromCloudinaryUrl,
  downloadResumeFromCloudinaryUrl,
  generateResumeUploadSignature,
} from "../services/media.service";

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

publicJobsRouter.post("/resume-signature", (req: Request, res: Response) => {
  try {
    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName : undefined;
    const signatureData = generateResumeUploadSignature(fileName);
    res.json({ data: signatureData });
  } catch (err) {
    console.error("Failed to generate resume upload signature:", err);
    res.status(500).json({ error: { message: "Failed to prepare resume upload." } });
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
      resumeUrl,
      resumeFileName,
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
      typeof resumeUrl === "string" && resumeUrl.trim()
        ? resumeUrl.trim()
        : typeof resumePublicId === "string" && resumePublicId.trim()
        ? resumePublicId.trim()
        : typeof resumeFileName === "string" && resumeFileName.trim()
        ? resumeFileName.trim()
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

    const data = applications.map((app) => {
      const isUrl = /^https?:\/\//i.test(app.resumePublicId);
      let resumeFileName = app.resumePublicId;
      if (isUrl) {
        try {
          const parsed = new URL(app.resumePublicId);
          resumeFileName = decodeURIComponent(parsed.pathname.split("/").pop() || "resume.pdf");
        } catch {
          resumeFileName = "resume.pdf";
        }
      }

      let extractedPhone: string | undefined;
      let cleanMessage = app.message || undefined;
      if (cleanMessage) {
        const phoneMatch = cleanMessage.match(/(?:^|\n\n)Phone:\s*(.+)$/i);
        if (phoneMatch) {
          extractedPhone = phoneMatch[1]?.trim();
          cleanMessage = cleanMessage.replace(/(?:^|\n\n)Phone:\s*.+$/i, "").trim() || undefined;
        }
      }

      return {
        id: app.id,
        jobId: app.jobId,
        jobTitle: app.job.title,
        name: app.name,
        email: app.email,
        phone: extractedPhone,
        resumeFileName,
        resumeUrl: isUrl ? app.resumePublicId : undefined,
        portfolioUrl: app.portfolioUrl,
        message: cleanMessage,
        status: app.status,
        createdAt: app.createdAt.toISOString(),
      };
    });

    res.json({ data });
  } catch (err) {
    console.error("Failed to fetch applications:", err);
    res.status(500).json({ error: { message: "Failed to load applications." } });
  }
});

adminApplicationsRouter.get("/:id/resume", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const id = String(req.params.id || "");
    const application = await prisma.jobApplication.findUnique({
      where: { id },
      select: { resumePublicId: true },
    });

    if (!application || !/^https?:\/\//i.test(application.resumePublicId)) {
      return res.status(404).json({ error: { message: "Resume file not found." } });
    }

    const { buffer, contentType, fileName } = await downloadResumeFromCloudinaryUrl(
      application.resumePublicId
    );

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${fileName.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(buffer);
  } catch (err) {
    console.error("Failed to stream application resume:", err);
    return res.status(500).json({ error: { message: "Failed to load resume file." } });
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

adminApplicationsRouter.delete("/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const id = String(req.params.id || "");
    const existing = await prisma.jobApplication.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, resumePublicId: true },
    });

    if (!existing) {
      return res.status(404).json({ error: { message: "Application not found." } });
    }

    if (/^https?:\/\//i.test(existing.resumePublicId)) {
      await deleteResumeFromCloudinaryUrl(existing.resumePublicId);
    }

    await prisma.jobApplication.delete({ where: { id } });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "APPLICATION_DELETED",
      entity: "JobApplication",
      entityId: id,
      meta: { name: existing.name, email: existing.email },
      req,
    });

    return res.json({ data: { deleted: true, id } });
  } catch (err) {
    console.error("Failed to delete application:", err);
    return res.status(500).json({ error: { message: "Failed to delete application." } });
  }
});

// ─── CREATE JOB ──────────────────────────────────────────────────────────────
adminJobsRouter.post("/", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const {
      title,
      department,
      location,
      type,
      workplaceType,
      description,
      skills,
      responsibilities,
      requirements,
      salary,
    } = req.body ?? {};

    if (!title || !description) {
      return res.status(400).json({
        error: { message: "Title and description are required." },
      });
    }

    const slug = slugifyDiscipline(title) + "-" + Date.now().toString(36);

    const job = await prisma.job.create({
      data: {
        slug,
        title: String(title).trim(),
        department: String(department || "Engineering").trim(),
        location: String(location || "Remote").trim(),
        type: String(type || "Full-time").trim(),
        workplaceType: String(workplaceType || "Remote").trim(),
        description: String(description).trim(),
        skills: Array.isArray(skills) ? skills.filter(Boolean) : [],
        responsibilities: Array.isArray(responsibilities) ? responsibilities.filter(Boolean) : [],
        requirements: Array.isArray(requirements) ? requirements.filter(Boolean) : [],
        salary: salary ? String(salary).trim() : null,
        status: "OPEN",
      },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "JOB_CREATED",
      entity: "Job",
      entityId: job.id,
      meta: { title: job.title, department: job.department },
      req,
    });

    res.status(201).json({ data: job });
  } catch (err) {
    console.error("Failed to create job:", err);
    res.status(500).json({ error: { message: "Failed to create job position." } });
  }
});

// ─── DELETE JOB (SOFT DELETE) ────────────────────────────────────────────────
adminJobsRouter.delete("/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const id = String(req.params.id || "");

    const existing = await prisma.job.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: { message: "Job not found." } });
    }

    await prisma.job.update({
      where: { id },
      data: { deletedAt: new Date(), status: "CLOSED" },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "JOB_DELETED",
      entity: "Job",
      entityId: id,
      meta: { title: existing.title },
      req,
    });

    res.json({ data: { deleted: true, id } });
  } catch (err) {
    console.error("Failed to delete job:", err);
    res.status(500).json({ error: { message: "Failed to delete job." } });
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
