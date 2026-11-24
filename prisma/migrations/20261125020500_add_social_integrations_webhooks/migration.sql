-- AlterTable SocialConnection (safe additive columns)
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "accountHandle" TEXT;
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DISCONNECTED';
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "connectedAt" TIMESTAMP(3);
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "connectedById" TEXT;
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMP(3);
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "lastHealthCheckAt" TIMESTAMP(3);
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "lastLatencyMs" INTEGER;
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "SocialConnection" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable OAuthState
CREATE TABLE IF NOT EXISTS "OAuthState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "codeVerifier" TEXT,
    "userId" TEXT NOT NULL,
    "redirectPath" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OAuthState_state_key" ON "OAuthState"("state");
CREATE INDEX IF NOT EXISTS "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateTable WebhookEndpoint
CREATE TABLE IF NOT EXISTS "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "secretEncrypted" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebhookEndpoint_isActive_createdAt_idx" ON "WebhookEndpoint"("isActive", "createdAt");

-- CreateTable WebhookDelivery
CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "latencyMs" INTEGER,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebhookDelivery_endpointId_deliveredAt_idx" ON "WebhookDelivery"("endpointId", "deliveredAt");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_deliveredAt_idx" ON "WebhookDelivery"("status", "deliveredAt");

DO $$ BEGIN
  ALTER TABLE "WebhookDelivery"
    ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
