import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SocialPlatform } from "../generated/prisma/enums";
import { countPlatformChars, PLATFORM_RULES } from "./platform-rules";

export type AiAdaptAction =
  | "shorten_x"
  | "technical_linkedin"
  | "format_reddit"
  | "generate_hashtags"
  | "improve_clarity"
  | "rewrite_platform";

export function getAiConfigStatus() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return {
    configured: Boolean(apiKey),
    provider: "Google Gemini",
    model: "gemini-2.5-flash",
  };
}

export async function adaptSocialCopyWithAi(params: {
  content: string;
  action: AiAdaptAction;
  targetPlatform: SocialPlatform;
}): Promise<{
  suggestion: string;
  targetPlatform: SocialPlatform;
  charCount: number;
  maxChars: number;
}> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const rule = PLATFORM_RULES[params.targetPlatform];
  const actionInstructions: Record<AiAdaptAction, string> = {
    shorten_x:
      "Condense this post for X (Twitter) so it fits strictly under 260 weighted characters (URLs count as 23 chars). Preserve key technical facts and any {{variable}} placeholders verbatim.",
    technical_linkedin:
      "Rewrite this for LinkedIn with structured engineering depth, clear paragraph breaks, and professional tone (under 2500 characters). Preserve any {{variable}} placeholders verbatim.",
    format_reddit:
      "Format this for a technical Reddit community using clean Markdown (headings/bullet points/code formatting if applicable). Avoid hype or marketing fluff. Preserve any {{variable}} placeholders verbatim.",
    generate_hashtags:
      "Keep the existing message intact and append 3-5 concise, high-signal technical hashtags at the end. Respect the target platform character limit.",
    improve_clarity:
      "Improve clarity, conciseness, and flow of this technical social post while keeping all facts and {{variable}} placeholders identical.",
    rewrite_platform: `Adapt this post specifically for ${rule.displayName} (max ${rule.maxChars} characters). Preserve all factual claims and {{variable}} placeholders verbatim.`,
  };

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = [
    "You are a senior technical editor for DEVCORE Solutions.",
    "STRICT RULES:",
    "- Never invent metrics, benchmarks, achievements, URLs, or product claims that are not in the source text.",
    "- Preserve all {{launch_url}}, {{product_name}}, and {{company_name}} placeholders exactly as written.",
    "- Return ONLY the rewritten post text. Do not wrap in markdown quotes or add explanations.",
    `Task: ${actionInstructions[params.action]}`,
    "",
    "Source content:",
    params.content,
  ].join("\n");

  const result = await model.generateContent(prompt);
  const suggestion = result.response.text().trim();
  if (!suggestion) {
    throw new Error("AI provider returned an empty suggestion.");
  }

  return {
    suggestion,
    targetPlatform: params.targetPlatform,
    charCount: countPlatformChars(params.targetPlatform, suggestion),
    maxChars: rule.maxChars,
  };
}
