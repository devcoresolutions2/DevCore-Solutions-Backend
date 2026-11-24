import type { SocialPlatform } from "../generated/prisma/enums";

export interface PlatformRuleSpec {
  platform: SocialPlatform;
  displayName: string;
  maxChars: number;
  urlShortenedLength: number | null; // e.g. X counts every URL as 23 chars
  maxImages: number;
  maxVideos: number;
  maxImageBytes: number;
  maxVideoBytes: number;
  maxGifBytes: number;
  supportsMarkdown: boolean;
  supportsPublish: boolean;
  requiredWriteScopes: string[];
}

export const PLATFORM_RULES: Record<SocialPlatform, PlatformRuleSpec> = {
  TWITTER_X: {
    platform: "TWITTER_X",
    displayName: "X (Twitter)",
    maxChars: 280,
    urlShortenedLength: 23,
    maxImages: 4,
    maxVideos: 1,
    maxImageBytes: 5 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    maxGifBytes: 15 * 1024 * 1024,
    supportsMarkdown: false,
    supportsPublish: true,
    requiredWriteScopes: ["tweet.write"],
  },
  LINKEDIN: {
    platform: "LINKEDIN",
    displayName: "LinkedIn",
    maxChars: 3000,
    urlShortenedLength: null,
    maxImages: 9,
    maxVideos: 1,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    maxGifBytes: 10 * 1024 * 1024,
    supportsMarkdown: false,
    supportsPublish: true,
    requiredWriteScopes: ["w_member_social"],
  },
  REDDIT: {
    platform: "REDDIT",
    displayName: "Reddit",
    maxChars: 40000,
    urlShortenedLength: null,
    maxImages: 20,
    maxVideos: 1,
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    maxGifBytes: 20 * 1024 * 1024,
    supportsMarkdown: true,
    supportsPublish: true,
    requiredWriteScopes: ["submit"],
  },
  META_FACEBOOK: {
    platform: "META_FACEBOOK",
    displayName: "Meta (Facebook)",
    maxChars: 2200, // Shared safe ceiling with Instagram captions
    urlShortenedLength: null,
    maxImages: 10,
    maxVideos: 1,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    maxGifBytes: 8 * 1024 * 1024,
    supportsMarkdown: false,
    supportsPublish: true,
    requiredWriteScopes: ["pages_manage_posts"],
  },
  META_INSTAGRAM: {
    platform: "META_INSTAGRAM",
    displayName: "Instagram",
    maxChars: 2200,
    urlShortenedLength: null,
    maxImages: 10,
    maxVideos: 1,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    maxGifBytes: 8 * 1024 * 1024,
    supportsMarkdown: false,
    supportsPublish: true,
    requiredWriteScopes: ["instagram_content_publish"],
  },
  YOUTUBE: {
    platform: "YOUTUBE",
    displayName: "YouTube",
    maxChars: 5000,
    urlShortenedLength: null,
    maxImages: 0,
    maxVideos: 1,
    maxImageBytes: 0,
    maxVideoBytes: 50 * 1024 * 1024,
    maxGifBytes: 0,
    supportsMarkdown: false,
    supportsPublish: false, // Current OAuth scope is youtube.readonly
    requiredWriteScopes: ["https://www.googleapis.com/auth/youtube.upload"],
  },
  GLASSDOOR: {
    platform: "GLASSDOOR",
    displayName: "Glassdoor",
    maxChars: 2000,
    urlShortenedLength: null,
    maxImages: 0,
    maxVideos: 0,
    maxImageBytes: 0,
    maxVideoBytes: 0,
    maxGifBytes: 0,
    supportsMarkdown: false,
    supportsPublish: false,
    requiredWriteScopes: [],
  },
};

export const ALLOWED_TEMPLATE_VARIABLES = [
  "launch_url",
  "product_name",
  "company_name",
] as const;

export type AllowedVariableKey = (typeof ALLOWED_TEMPLATE_VARIABLES)[number];

/**
 * Computes platform-accurate character count (including X t.co 23-char URL weighting
 * and Unicode surrogate/grapheme handling).
 */
export function countPlatformChars(platform: SocialPlatform, text: string): number {
  const rule = PLATFORM_RULES[platform];
  if (!text) return 0;

  if (rule.urlShortenedLength !== null) {
    const urlRegex = /https?:\/\/[^\s]+/gi;
    let remaining = text;
    let urlCount = 0;
    remaining = remaining.replace(urlRegex, () => {
      urlCount += 1;
      return "";
    });

    // Weight emojis/wide astral chars as 2 per X counting spec
    let weight = urlCount * rule.urlShortenedLength;
    for (const ch of remaining) {
      const cp = ch.codePointAt(0) ?? 0;
      weight += cp > 0x10ff ? 2 : 1;
    }
    return weight;
  }

  return Array.from(text).length;
}

/**
 * Safely resolves controlled {{variable}} placeholders without template execution.
 * Rejects any unresolved {{...}} placeholders if strict=true.
 */
export function resolveControlledVariables(
  text: string,
  values: Partial<Record<AllowedVariableKey, string>>,
  strict = true,
): { resolved: string; unresolved: string[] } {
  const unresolvedSet = new Set<string>();
  const resolved = text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if ((ALLOWED_TEMPLATE_VARIABLES as readonly string[]).includes(key)) {
      const val = values[key as AllowedVariableKey]?.trim();
      if (val) return val;
    }
    unresolvedSet.add(key);
    return match;
  });

  const unresolved = Array.from(unresolvedSet);
  if (strict && unresolved.length > 0) {
    throw new Error(
      `Unresolved or unsupported template variables: ${unresolved.map((v) => `{{${v}}}`).join(", ")}`,
    );
  }
  return { resolved, unresolved };
}

export function validatePlatformPayload(
  platform: SocialPlatform,
  resolvedText: string,
  media: Array<{ resourceType: string; format: string; bytes: number; fileName: string }>,
): { valid: boolean; charCount: number; maxChars: number; errors: string[] } {
  const rule = PLATFORM_RULES[platform];
  const errors: string[] = [];
  const charCount = countPlatformChars(platform, resolvedText);

  if (!rule.supportsPublish) {
    errors.push(`${rule.displayName} does not support automated text broadcast publishing.`);
  }

  if (!resolvedText.trim() && media.length === 0) {
    errors.push("Post content or media attachment is required.");
  }

  if (charCount > rule.maxChars) {
    errors.push(
      `Content exceeds ${rule.displayName} limit (${charCount} / ${rule.maxChars} chars).`,
    );
  }

  const images = media.filter((m) => m.resourceType === "image" && m.format !== "gif");
  const gifs = media.filter((m) => m.format === "gif");
  const videos = media.filter((m) => m.resourceType === "video");

  if (images.length > rule.maxImages) {
    errors.push(`${rule.displayName} supports at most ${rule.maxImages} images.`);
  }
  if (videos.length > rule.maxVideos) {
    errors.push(`${rule.displayName} supports at most ${rule.maxVideos} video.`);
  }
  if (platform === "TWITTER_X" && gifs.length > 0 && (images.length > 0 || videos.length > 0 || gifs.length > 1)) {
    errors.push("X supports either 1 GIF, 1 video, or up to 4 images per post.");
  }

  for (const m of media) {
    if (m.format === "gif" && m.bytes > rule.maxGifBytes) {
      errors.push(`${m.fileName} exceeds ${rule.displayName} GIF size limit.`);
    } else if (m.resourceType === "image" && m.format !== "gif" && m.bytes > rule.maxImageBytes) {
      errors.push(`${m.fileName} exceeds ${rule.displayName} image size limit.`);
    } else if (m.resourceType === "video" && m.bytes > rule.maxVideoBytes) {
      errors.push(`${m.fileName} exceeds ${rule.displayName} video size limit.`);
    }
  }

  return {
    valid: errors.length === 0,
    charCount,
    maxChars: rule.maxChars,
    errors,
  };
}
