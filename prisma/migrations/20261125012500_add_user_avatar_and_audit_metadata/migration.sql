-- AlterTable: Add optional username and Cloudinary avatar metadata to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarPublicId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarVersion" INTEGER;

-- CreateIndex: Unique index for optional username (PostgreSQL allows multiple NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");

-- AlterTable: Add status and non-sensitive metadata JSON to AuthEvent
ALTER TABLE "AuthEvent" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'SUCCESS';
ALTER TABLE "AuthEvent" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
