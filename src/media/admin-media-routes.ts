import { Router, Response } from "express";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../server/db/prisma";
import {
  AuthenticatedAdminRequest,
  recordAdminAudit,
  requireAdminSession,
} from "../security/admin-middleware";
import {
  deleteSocialMediaFromCloudinary,
  generateSocialMediaUploadSignature,
  verifyAndBuildSocialMediaAsset,
} from "../services/media.service";

export const adminMediaRouter = Router();

adminMediaRouter.use(requireAdminSession(["SUPER_ADMIN", "EDITOR"]));

// ─── LIST / SEARCH / FILTER / PAGINATE MEDIA ASSETS ───────────────────────────

adminMediaRouter.get("/", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "12"), 10) || 12));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const typeFilter = typeof req.query.type === "string" ? req.query.type.toLowerCase() : "all";
    const usageFilter = typeof req.query.usage === "string" ? req.query.usage.toLowerCase() : "all";
    const sortBy = typeof req.query.sort === "string" ? req.query.sort : "newest";

    const where: Prisma.SocialMediaAssetWhereInput = {};
    if (typeFilter === "image") where.resourceType = "image";
    else if (typeFilter === "video") where.resourceType = "video";
    else if (typeFilter === "svg") where.format = "svg";

    if (usageFilter === "used") where.postId = { not: null };
    else if (usageFilter === "unused") where.postId = null;

    if (search) {
      where.OR = [
        { fileName: { contains: search, mode: "insensitive" } },
        { altText: { contains: search, mode: "insensitive" } },
        { format: { contains: search, mode: "insensitive" } },
        { tags: { has: search } },
      ];
    }

    const orderBy: Prisma.SocialMediaAssetOrderByWithRelationInput =
      sortBy === "oldest"
        ? { createdAt: "asc" }
        : sortBy === "filename"
          ? { fileName: "asc" }
          : sortBy === "largest"
            ? { bytes: "desc" }
            : sortBy === "smallest"
              ? { bytes: "asc" }
              : { createdAt: "desc" };

    const [total, items, allStats, usedCount] = await Promise.all([
      prisma.socialMediaAsset.count({ where }),
      prisma.socialMediaAsset.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          post: { select: { id: true, title: true, status: true } },
        },
      }),
      prisma.socialMediaAsset.aggregate({
        _count: { _all: true },
        _sum: { bytes: true },
      }),
      prisma.socialMediaAsset.count({ where: { postId: { not: null } } }),
    ]);

    const totalAssets = allStats._count._all;
    const totalBytes = allStats._sum.bytes || 0;

    return res.json({
      items,
      stats: {
        totalAssets,
        totalBytes,
        usedAssets: usedCount,
        unusedAssets: Math.max(0, totalAssets - usedCount),
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error("List media assets error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load media." } });
  }
});

// ─── EXPORT MANIFEST JSON ─────────────────────────────────────────────────────

adminMediaRouter.get("/export", async (req: AuthenticatedAdminRequest, res: Response) => {
  try {
    const assets = await prisma.socialMediaAsset.findMany({
      orderBy: { createdAt: "desc" },
      take: 1000,
      include: { post: { select: { id: true, title: true, status: true } } },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "MEDIA_MANIFEST_EXPORTED",
      entity: "SocialMediaAsset",
      entityId: "EXPORT",
      meta: { count: assets.length },
      req,
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="devcore-media-manifest-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: assets.length, assets }, null, 2));
  } catch (err) {
    console.error("Media manifest export error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Export failed." } });
  }
});

// ─── SIGN, VERIFY, UPDATE METADATA, REPLACE, SAFE DELETE ──────────────────────

adminMediaRouter.post("/sign", (req: AuthenticatedAdminRequest, res: Response) => {
  const resourceType = req.body?.resourceType === "video" ? "video" : "image";
  try {
    const signatureData = generateSocialMediaUploadSignature(req.authUser!.id, resourceType);
    return res.json(signatureData);
  } catch (err: any) {
    return res.status(500).json({
      error: { code: "CLOUDINARY_ERROR", message: err?.message || "Failed to sign upload." },
    });
  }
});

adminMediaRouter.post("/verify", async (req: AuthenticatedAdminRequest, res: Response) => {
  const publicId = typeof req.body?.publicId === "string" ? req.body.publicId.trim() : "";
  const resourceType = req.body?.resourceType === "video" ? "video" : "image";
  const fileName =
    typeof req.body?.fileName === "string" && req.body.fileName.trim()
      ? req.body.fileName.trim().slice(0, 180)
      : "asset";
  const altText =
    typeof req.body?.altText === "string" ? req.body.altText.trim().slice(0, 400) : "";

  if (!publicId) {
    return res.status(400).json({ error: { code: "INVALID_INPUT", message: "publicId is required." } });
  }

  try {
    const verified = await verifyAndBuildSocialMediaAsset(
      publicId,
      resourceType,
      req.authUser!.id,
    );
    const asset = await prisma.socialMediaAsset.create({
      data: {
        uploadedById: req.authUser!.id,
        publicId: verified.publicId,
        secureUrl: verified.secureUrl,
        resourceType: verified.resourceType,
        format: verified.format,
        bytes: verified.bytes,
        width: verified.width,
        height: verified.height,
        durationSec: verified.durationSec,
        fileName,
        altText: altText || null,
      },
    });

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "MEDIA_UPLOADED",
      entity: "SocialMediaAsset",
      entityId: asset.id,
      meta: { fileName: asset.fileName, format: asset.format, bytes: asset.bytes },
      req,
    });

    return res.status(201).json({ asset });
  } catch (err: any) {
    return res.status(400).json({
      error: { code: "MEDIA_VERIFY_FAILED", message: err?.message || "Verification failed." },
    });
  }
});

adminMediaRouter.patch("/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.socialMediaAsset.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Media asset not found." } });
  }

  const data: Record<string, any> = {};
  if (typeof req.body?.altText === "string") {
    data.altText = req.body.altText.trim().slice(0, 400) || null;
  }
  if (Array.isArray(req.body?.tags)) {
    data.tags = req.body.tags
      .filter((t: unknown): t is string => typeof t === "string")
      .map((t: string) => t.trim().slice(0, 40))
      .filter(Boolean);
  }

  const updated = await prisma.socialMediaAsset.update({
    where: { id },
    data,
    include: { post: { select: { id: true, title: true, status: true } } },
  });

  await recordAdminAudit({
    actorId: req.authUser!.id,
    action: "MEDIA_METADATA_UPDATED",
    entity: "SocialMediaAsset",
    entityId: id,
    meta: { changedFields: Object.keys(data) },
    req,
  });

  return res.json({ asset: updated });
});

adminMediaRouter.delete("/:id", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.socialMediaAsset.findUnique({
    where: { id },
    include: { post: { select: { id: true, title: true } } },
  });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Media asset not found." } });
  }

  if (existing.postId) {
    return res.status(409).json({
      error: {
        code: "ASSET_IN_USE",
        message: `Cannot delete asset: linked to broadcast ${existing.postId}.`,
      },
    });
  }

  const rt = existing.resourceType === "video" ? "video" : "image";
  await deleteSocialMediaFromCloudinary(existing.publicId, rt);
  await prisma.socialMediaAsset.delete({ where: { id } });

  await recordAdminAudit({
    actorId: req.authUser!.id,
    action: "MEDIA_DELETED",
    entity: "SocialMediaAsset",
    entityId: id,
    meta: { fileName: existing.fileName },
    req,
  });

  return res.json({ deleted: true, id });
});

// ─── REPLACE EXISTING ASSET SAFELY ────────────────────────────────────────────

adminMediaRouter.post("/:id/replace", async (req: AuthenticatedAdminRequest, res: Response) => {
  const id = String(req.params.id || "");
  const existing = await prisma.socialMediaAsset.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Media asset not found." } });
  }

  const publicId = typeof req.body?.publicId === "string" ? req.body.publicId.trim() : "";
  const resourceType = req.body?.resourceType === "video" ? "video" : "image";
  const fileName =
    typeof req.body?.fileName === "string" && req.body.fileName.trim()
      ? req.body.fileName.trim().slice(0, 180)
      : existing.fileName;

  if (!publicId) {
    return res.status(400).json({ error: { code: "INVALID_INPUT", message: "publicId is required." } });
  }

  try {
    const verified = await verifyAndBuildSocialMediaAsset(
      publicId,
      resourceType,
      req.authUser!.id,
    );

    const updated = await prisma.socialMediaAsset.update({
      where: { id },
      data: {
        publicId: verified.publicId,
        secureUrl: verified.secureUrl,
        resourceType: verified.resourceType,
        format: verified.format,
        bytes: verified.bytes,
        width: verified.width,
        height: verified.height,
        durationSec: verified.durationSec,
        fileName,
      },
      include: { post: { select: { id: true, title: true, status: true } } },
    });

    // Clean up old asset only AFTER DB update succeeds
    const oldRt = existing.resourceType === "video" ? "video" : "image";
    if (existing.publicId !== verified.publicId) {
      await deleteSocialMediaFromCloudinary(existing.publicId, oldRt).catch(() => {});
    }

    await recordAdminAudit({
      actorId: req.authUser!.id,
      action: "MEDIA_REPLACED",
      entity: "SocialMediaAsset",
      entityId: id,
      meta: { oldFileName: existing.fileName, newFileName: updated.fileName },
      req,
    });

    return res.json({ asset: updated });
  } catch (err: any) {
    return res.status(400).json({
      error: { code: "MEDIA_REPLACE_FAILED", message: err?.message || "Replacement failed." },
    });
  }
});
