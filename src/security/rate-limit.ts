import { Redis } from "@upstash/redis";

let redis: Redis | null = null;
if (process.env.RATE_LIMIT_REDIS_URL && process.env.RATE_LIMIT_REDIS_TOKEN) {
  try {
    redis = new Redis({
      url: process.env.RATE_LIMIT_REDIS_URL,
      token: process.env.RATE_LIMIT_REDIS_TOKEN,
    });
  } catch (err) {
    console.warn("Failed to initialize Upstash Redis, falling back to in-memory rate limiting:", err);
  }
}

// In-memory fallback sliding window store
interface RateLimitRecord {
  count: number;
  resetAt: number;
}
const memoryStore = new Map<string, RateLimitRecord>();

export async function checkRateLimit(
  key: string,
  maxAttempts = 5,
  windowSeconds = 60
): Promise<{ allowed: boolean; remaining: number; resetInSeconds: number }> {
  const now = Date.now();

  // Try Redis first if configured
  if (redis) {
    try {
      const redisKey = `ratelimit:${key}`;
      const count = await redis.incr(redisKey);
      if (count === 1) {
        await redis.expire(redisKey, windowSeconds);
      }
      const ttl = await redis.ttl(redisKey);
      const resetInSeconds = ttl > 0 ? ttl : windowSeconds;

      if (count > maxAttempts) {
        return { allowed: false, remaining: 0, resetInSeconds };
      }
      return { allowed: true, remaining: maxAttempts - count, resetInSeconds };
    } catch {
      // Fallback to in-memory
    }
  }

  // In-memory sliding window
  const record = memoryStore.get(key);
  if (!record || now >= record.resetAt) {
    memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: maxAttempts - 1, resetInSeconds: windowSeconds };
  }

  if (record.count >= maxAttempts) {
    const resetInSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, resetInSeconds };
  }

  record.count += 1;
  const resetInSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  return { allowed: true, remaining: maxAttempts - record.count, resetInSeconds };
}
