import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getMasterKey(): Buffer {
  const raw = process.env.ENCRYPTION_MASTER_KEY?.trim();
  if (!raw) {
    throw new Error("ENCRYPTION_MASTER_KEY is not configured in environment.");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // Fallback deterministic 32-byte key derivation if non-hex string is provided
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function getEncryptionKeyVersion(): number {
  const parsed = Number.parseInt(process.env.ENCRYPTION_KEY_VERSION || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Encrypts sensitive plaintext (OAuth access/refresh tokens, webhook secrets)
 * using AES-256-GCM with authenticated encryption.
 */
export function encryptSecret(plaintext: string): { ciphertext: string; keyVersion: number } {
  const key = getMasterKey();
  const keyVersion = getEncryptionKeyVersion();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: `v${keyVersion}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`,
    keyVersion,
  };
}

/**
 * Decrypts a secret produced by encryptSecret().
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || !parts[0]?.startsWith("v") || !parts[1] || !parts[2] || !parts[3]) {
    throw new Error("Invalid encrypted secret format.");
  }

  const key = getMasterKey();
  const iv = Buffer.from(parts[1], "base64");
  const authTag = Buffer.from(parts[2], "base64");
  const encrypted = Buffer.from(parts[3], "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Generates a high-entropy webhook signing secret with a recognizable prefix.
 */
export function generateWebhookSecret(): string {
  return `whsec_devcore_${crypto.randomBytes(24).toString("hex")}`;
}

/**
 * Computes HMAC-SHA256 signature for webhook payloads:
 * signature = HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
 */
export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
}
