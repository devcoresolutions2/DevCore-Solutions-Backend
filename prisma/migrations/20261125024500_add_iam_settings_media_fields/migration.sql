-- AlterTable ContactSettings
ALTER TABLE "ContactSettings" ADD COLUMN IF NOT EXISTS "organizationName" TEXT DEFAULT 'DevCore Solutions';
ALTER TABLE "ContactSettings" ADD COLUMN IF NOT EXISTS "afterHoursPolicy" TEXT NOT NULL DEFAULT 'NEXT_BUSINESS_DAY';
ALTER TABLE "ContactSettings" ADD COLUMN IF NOT EXISTS "incidentContact" TEXT;
ALTER TABLE "ContactSettings" ADD COLUMN IF NOT EXISTS "secureMessagingContact" TEXT;
ALTER TABLE "ContactSettings" ADD COLUMN IF NOT EXISTS "seoDefaults" JSONB;
ALTER TABLE "ContactSettings" ADD COLUMN IF NOT EXISTS "brandAssets" JSONB;
ALTER TABLE "ContactSettings" ADD COLUMN IF NOT EXISTS "updatedById" TEXT;

-- AlterTable SocialMediaAsset
ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "folder" TEXT;

-- CreateTable UserInvitation
CREATE TABLE IF NOT EXISTS "UserInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "tokenHash" TEXT NOT NULL,
    "message" TEXT,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "UserInvitation_email_createdAt_idx" ON "UserInvitation"("email", "createdAt");
CREATE INDEX IF NOT EXISTS "UserInvitation_expiresAt_idx" ON "UserInvitation"("expiresAt");
