import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../server/db/prisma";
import { decryptSecret, signWebhookPayload } from "../security/encryption";

export const SUPPORTED_WEBHOOK_EVENTS = [
  "lead.created",
  "lead.status_changed",
  "post.published",
  "post.failed",
  "integration.connected",
  "integration.disconnected",
  "integration.expiring_soon",
  "webhook.test",
] as const;

export type WebhookEventType = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];

function isPrivateOrBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const a = parts[0]!;
  const b = parts[1]!;

  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
  if (a === 0 || a === 10 || a === 127) return true;
  // 169.254.0.0/16 (link-local & cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 multicast & reserved
  if (a >= 224) return true;

  return false;
}

function isPrivateOrBlockedIp(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();
  if (net.isIPv4(normalized)) {
    return isPrivateOrBlockedIpv4(normalized);
  }
  if (net.isIPv6(normalized)) {
    if (normalized === "::1" || normalized === "::") return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    if (normalized.startsWith("::ffff:")) {
      const v4 = normalized.slice(7);
      if (net.isIPv4(v4)) return isPrivateOrBlockedIpv4(v4);
    }
    // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    ) {
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Validates an outbound webhook URL against SSRF vectors:
 * - Only http/https allowed (rejects file:, ftp:, javascript:, etc.)
 * - Blocks localhost, .local, .internal, .localhost
 * - Blocks private, loopback, link-local, metadata, and multicast IPs
 * - Resolves DNS and verifies all returned addresses are public
 */
export async function validateWebhookUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid URL format.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL must use HTTPS or HTTP.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Webhook URL must not embed credentials.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Localhost and internal hostnames are blocked for webhook targets.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrBlockedIp(hostname)) {
      throw new Error("Private, loopback, or link-local IP addresses are blocked.");
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) {
      throw new Error("Webhook hostname did not resolve to any IP address.");
    }
    for (const rec of records) {
      if (isPrivateOrBlockedIp(rec.address)) {
        throw new Error("Webhook hostname resolves to a blocked private or internal IP.");
      }
    }
  } catch (err: any) {
    if (err instanceof Error && err.message.includes("blocked")) {
      throw err;
    }
    throw new Error(`DNS resolution failed for webhook host "${hostname}".`);
  }

  return parsed;
}

export async function dispatchWebhookDelivery(params: {
  endpointId: string;
  eventType: string;
  data: Record<string, unknown>;
  attemptCount?: number;
}) {
  const endpoint = await prisma.webhookEndpoint.findUnique({
    where: { id: params.endpointId },
  });
  if (!endpoint) {
    throw new Error("Webhook endpoint not found.");
  }

  // Re-validate SSRF right before outbound request (protects against DNS rebinding)
  await validateWebhookUrl(endpoint.url);

  const deliveryId = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadObj = {
    id: deliveryId,
    event: params.eventType,
    createdAt: new Date().toISOString(),
    data: params.data,
  };
  const rawBody = JSON.stringify(payloadObj);

  const secret = decryptSecret(endpoint.secretEncrypted);
  const signature = signWebhookPayload(secret, timestamp, rawBody);

  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let status: "SUCCESS" | "FAILED" = "FAILED";
  let errorMessage: string | null = null;

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "DevCore-Webhooks/1.0",
        "X-DevCore-Event": params.eventType,
        "X-DevCore-Delivery": deliveryId,
        "X-DevCore-Timestamp": timestamp,
        "X-DevCore-Signature": `t=${timestamp},v1=${signature}`,
      },
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });

    responseStatus = res.status;
    const text = await res.text().catch(() => "");
    responseBody = text.slice(0, 1500);
    if (res.ok) {
      status = "SUCCESS";
    } else {
      errorMessage = `Endpoint responded with HTTP ${res.status}`;
    }
  } catch (err: any) {
    errorMessage = err?.message ? String(err.message).slice(0, 500) : "Network delivery failed";
  }

  const latencyMs = Date.now() - startedAt;

  const [delivery] = await prisma.$transaction([
    prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventType: params.eventType,
        payload: payloadObj as Prisma.InputJsonValue,
        responseStatus,
        responseBody,
        latencyMs,
        attemptCount: params.attemptCount ?? 1,
        status,
        errorMessage,
      },
    }),
    prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        lastDeliveryAt: new Date(),
        lastStatusCode: responseStatus,
        lastError: errorMessage,
      },
    }),
  ]);

  return delivery;
}
