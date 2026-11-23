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
  return await cloudinary.uploader.destroy(publicId);
}
