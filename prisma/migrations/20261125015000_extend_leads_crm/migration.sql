-- AlterEnum: Add CONTACT_FORM to LeadSource
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'CONTACT_FORM';

-- CreateEnum: LeadPriority
DO $$ BEGIN
  CREATE TYPE "LeadPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable: Lead
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "website" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "budgetMin" INTEGER;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "referrer" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "priority" "LeadPriority" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "assignedToId" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "lastContactedAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nextFollowUpAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

-- AlterTable: LeadStatusChange
ALTER TABLE "LeadStatusChange" ADD COLUMN IF NOT EXISTS "eventType" TEXT NOT NULL DEFAULT 'STATUS_CHANGE';
ALTER TABLE "LeadStatusChange" ADD COLUMN IF NOT EXISTS "details" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_source_createdAt_idx" ON "Lead"("source", "createdAt");
CREATE INDEX IF NOT EXISTS "Lead_assignedToId_idx" ON "Lead"("assignedToId");
CREATE INDEX IF NOT EXISTS "Lead_priority_status_idx" ON "Lead"("priority", "status");
CREATE INDEX IF NOT EXISTS "LeadNote_leadId_createdAt_idx" ON "LeadNote"("leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "LeadStatusChange_leadId_createdAt_idx" ON "LeadStatusChange"("leadId", "createdAt");

-- AddForeignKeys safely
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "LeadNote" ADD CONSTRAINT "LeadNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "LeadStatusChange" ADD CONSTRAINT "LeadStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
