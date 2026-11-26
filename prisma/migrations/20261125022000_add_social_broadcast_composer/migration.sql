-- AlterEnum PostStatus
DO $$ BEGIN
  ALTER TYPE "PostStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable SocialPost
ALTER TABLE "SocialPost" ADD COLUMN IF NOT EXISTS "variables" JSONB;
ALTER TABLE "SocialPost" ADD COLUMN IF NOT EXISTS "timezone" TEXT DEFAULT 'UTC';
ALTER TABLE "SocialPost" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

-- AlterTable SocialDeliveryLog
ALTER TABLE "SocialDeliveryLog" ADD COLUMN IF NOT EXISTS "latencyMs" INTEGER;
ALTER TABLE "SocialDeliveryLog" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 1;

-- CreateTable SocialMediaAsset
CREATE TABLE IF NOT EXISTS "SocialMediaAsset" (
    "id" TEXT NOT NULL,
    "postId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "secureUrl" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "fileName" TEXT NOT NULL,
    "altText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialMediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialMediaAsset_publicId_key" ON "SocialMediaAsset"("publicId");
CREATE INDEX IF NOT EXISTS "SocialMediaAsset_postId_sortOrder_idx" ON "SocialMediaAsset"("postId", "sortOrder");
CREATE INDEX IF NOT EXISTS "SocialMediaAsset_uploadedById_createdAt_idx" ON "SocialMediaAsset"("uploadedById", "createdAt");

DO $$ BEGIN
  ALTER TABLE "SocialMediaAsset"
    ADD CONSTRAINT "SocialMediaAsset_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
