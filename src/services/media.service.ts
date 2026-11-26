import { v2 as cloudinary, UploadApiResponse } from "cloudinary";

// Initialize Cloudinary from CLOUDINARY_URL or explicit keys
function initCloudinary() {
  const envUrl = process.env.CLOUDINARY_URL;
  if (envUrl && envUrl.startsWith("cloudinary://")) {
    const withoutProtocol = envUrl.replace("cloudinary://", "");
    const [auth, cloudName] = withoutProtocol.split("@");
    if (auth && cloudName) {
      const [apiKey, apiSecret] = auth.split(":");
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      return;
    }
  }

  // Fallback to direct keys
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "vrbru3ro",
    api_key: process.env.CLOUDINARY_API_KEY || "885229266153679",
    api_secret: process.env.CLOUDINARY_API_SECRET || "kdrnOZvx-e3hSfa40byyS7NWKgM",
    secure: true,
  });
}

initCloudinary();

export const BRANDING_LOGOS = {
  light: "https://res.cloudinary.com/vrbru3ro/image/upload/v1795471039/devcore/branding/logo-light.png",
  dark: "https://res.cloudinary.com/vrbru3ro/image/upload/v1795471040/devcore/branding/logo-dark.png",
};

export async function uploadToCloudinary(
  filePathOrBase64: string,
  options?: {
    folder?: string;
    publicId?: string;
    overwrite?: boolean;
    resourceType?: "image" | "raw" | "auto" | "video";
  }
): Promise<UploadApiResponse> {
  const folder = options?.folder || process.env.CLOUDINARY_UPLOAD_FOLDER || "devcore";

  return await cloudinary.uploader.upload(filePathOrBase64, {
    folder,
    public_id: options?.publicId,
    overwrite: options?.overwrite ?? true,
    resource_type: options?.resourceType || "image",
  });
}

export async function deleteFromCloudinary(publicId: string): Promise<any> {
  return await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
}

export const AVATAR_FOLDER = "devcore/users/avatars";
export const MAX_AVATAR_BYTES = 25 * 1024 * 1024; // 25 MB
export const ALLOWED_AVATAR_FORMATS = ["jpg", "jpeg", "png", "webp"];

export function generateAvatarUploadSignature(userId: string) {
  const config = cloudinary.config();
  if (!config.cloud_name || !config.api_key || !config.api_secret) {
    throw new Error("Cloudinary credentials are not configured on the server.");
  }

  const timestamp = Math.round(Date.now() / 1000);
  const publicId = `avatar_${userId}_${Date.now()}`;
  const eager = "c_fill,g_face,w_512,h_512,f_auto,q_auto";
  const allowedFormats = ALLOWED_AVATAR_FORMATS.join(",");

  const paramsToSign = {
    allowed_formats: allowedFormats,
    eager,
    folder: AVATAR_FOLDER,
    public_id: publicId,
    timestamp,
  };

  const signature = cloudinary.utils.api_sign_request(paramsToSign, config.api_secret);

  return {
    signature,
    timestamp,
    apiKey: config.api_key,
    cloudName: config.cloud_name,
    folder: AVATAR_FOLDER,
    publicId,
    eager,
    allowedFormats,
    maxFileSizeBytes: MAX_AVATAR_BYTES,
  };
}

export async function verifyAndBuildAvatarResult(publicId: string, expectedUserId: string) {
  const expectedPrefix = `${AVATAR_FOLDER}/avatar_${expectedUserId}_`;
  if (!publicId || typeof publicId !== "string" || !publicId.startsWith(expectedPrefix)) {
    throw new Error("Invalid or unauthorized Cloudinary asset identifier.");
  }

  const resource = await cloudinary.api.resource(publicId, { resource_type: "image" });

  if (!resource || resource.resource_type !== "image") {
    throw new Error("Uploaded asset is not a valid image.");
  }

  const format = String(resource.format || "").toLowerCase();
  if (!ALLOWED_AVATAR_FORMATS.includes(format)) {
    await deleteFromCloudinary(publicId).catch(() => {});
    throw new Error(`Unsupported image format: ${format}. Allowed formats: JPG, PNG, WebP.`);
  }

  if (typeof resource.bytes === "number" && resource.bytes > MAX_AVATAR_BYTES) {
    await deleteFromCloudinary(publicId).catch(() => {});
    throw new Error("Uploaded image exceeds the 25 MB maximum size limit.");
  }

  const optimizedUrl = cloudinary.url(resource.public_id, {
    secure: true,
    version: resource.version,
    transformation: [
      { width: 512, height: 512, crop: "fill", gravity: "face" },
      { fetch_format: "auto", quality: "auto" },
    ],
  });

  return {
    url: optimizedUrl,
    publicId: resource.public_id as string,
    version: Number(resource.version) || undefined,
    bytes: Number(resource.bytes) || 0,
    format,
    width: Number(resource.width) || 0,
    height: Number(resource.height) || 0,
  };
}

// ─── SOCIAL BROADCAST MEDIA ASSETS ────────────────────────────────────────────

export const SOCIAL_MEDIA_FOLDER = "devcore/social/broadcasts";
export const MAX_SOCIAL_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_SOCIAL_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
export const ALLOWED_SOCIAL_IMAGE_FORMATS = ["png", "jpg", "jpeg", "webp", "gif"];
export const ALLOWED_SOCIAL_VIDEO_FORMATS = ["mp4", "mov", "webm"];

export function generateSocialMediaUploadSignature(
  userId: string,
  resourceType: "image" | "video" = "image",
) {
  const config = cloudinary.config();
  if (!config.cloud_name || !config.api_key || !config.api_secret) {
    throw new Error("Cloudinary credentials are not configured on the server.");
  }

  const timestamp = Math.round(Date.now() / 1000);
  const publicId = `media_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const allowedFormats =
    resourceType === "video"
      ? ALLOWED_SOCIAL_VIDEO_FORMATS.join(",")
      : ALLOWED_SOCIAL_IMAGE_FORMATS.join(",");

  const paramsToSign = {
    allowed_formats: allowedFormats,
    folder: SOCIAL_MEDIA_FOLDER,
    public_id: publicId,
    timestamp,
  };

  const signature = cloudinary.utils.api_sign_request(paramsToSign, config.api_secret);

  return {
    signature,
    timestamp,
    apiKey: config.api_key,
    cloudName: config.cloud_name,
    folder: SOCIAL_MEDIA_FOLDER,
    publicId,
    resourceType,
    allowedFormats,
    maxFileSizeBytes: resourceType === "video" ? MAX_SOCIAL_VIDEO_BYTES : MAX_SOCIAL_IMAGE_BYTES,
  };
}

export async function deleteSocialMediaFromCloudinary(
  publicId: string,
  resourceType: "image" | "video" = "image",
) {
  return await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  });
}

export async function verifyAndBuildSocialMediaAsset(
  publicId: string,
  resourceType: "image" | "video",
  expectedUserId: string,
) {
  const expectedPrefix = `${SOCIAL_MEDIA_FOLDER}/media_${expectedUserId}_`;
  if (!publicId || typeof publicId !== "string" || !publicId.startsWith(expectedPrefix)) {
    throw new Error("Invalid or unauthorized Cloudinary asset identifier.");
  }

  const resource = await cloudinary.api.resource(publicId, { resource_type: resourceType });
  if (!resource || resource.resource_type !== resourceType) {
    throw new Error(`Uploaded asset is not a valid ${resourceType}.`);
  }

  const format = String(resource.format || "").toLowerCase();
  const allowed =
    resourceType === "video" ? ALLOWED_SOCIAL_VIDEO_FORMATS : ALLOWED_SOCIAL_IMAGE_FORMATS;

  if (!allowed.includes(format)) {
    await deleteSocialMediaFromCloudinary(publicId, resourceType).catch(() => {});
    throw new Error(`Unsupported ${resourceType} format: ${format}.`);
  }

  const maxBytes = resourceType === "video" ? MAX_SOCIAL_VIDEO_BYTES : MAX_SOCIAL_IMAGE_BYTES;
  const bytes = Number(resource.bytes) || 0;
  if (bytes > maxBytes) {
    await deleteSocialMediaFromCloudinary(publicId, resourceType).catch(() => {});
    throw new Error(
      `Uploaded ${resourceType} exceeds maximum size limit (${Math.round(maxBytes / (1024 * 1024))} MB).`,
    );
  }

  return {
    publicId: String(resource.public_id),
    secureUrl: String(resource.secure_url),
    resourceType,
    format,
    bytes,
    width: typeof resource.width === "number" ? resource.width : null,
    height: typeof resource.height === "number" ? resource.height : null,
    durationSec: typeof resource.duration === "number" ? resource.duration : null,
  };
}
