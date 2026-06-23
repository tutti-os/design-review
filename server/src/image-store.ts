import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { BadRequestError } from "./errors.js";

const ALLOWED_IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function imageSuffix(mediaType: string): string {
  const value = mediaType.toLowerCase();
  if (value === "image/jpeg") return ".jpg";
  if (value === "image/webp") return ".webp";
  if (value === "image/gif") return ".gif";
  return ".png";
}

export async function saveBase64Image(input: { runtimeDir: string; data: string; mediaType: string }): Promise<string> {
  const data = input.data.trim();
  if (!data) throw new BadRequestError("图片数据为空。");
  const raw = Buffer.from(data, "base64");
  if (raw.length === 0) throw new BadRequestError("图片数据不是合法 base64。");
  const imageDir = path.join(input.runtimeDir, "uploads");
  await mkdir(imageDir, { recursive: true });
  const filePath = path.join(imageDir, `design-review-${randomUUID().slice(0, 12)}${imageSuffix(input.mediaType)}`);
  await import("node:fs/promises").then((fs) => fs.writeFile(filePath, raw));
  return filePath;
}

export async function validateImagePath(imagePath: string, allowedRoots: string[]): Promise<string> {
  if (!path.isAbsolute(imagePath)) throw new BadRequestError("image-path must be an absolute path.");
  const suffix = path.extname(imagePath).toLowerCase();
  if (!ALLOWED_IMAGE_SUFFIXES.has(suffix)) {
    throw new BadRequestError("image-path must be a PNG/JPEG/WebP/GIF image.");
  }
  const real = await import("node:fs/promises")
    .then((fs) => fs.realpath(imagePath))
    .catch((error) => {
      throw new BadRequestError(`image-path not found: ${imagePath}`, { cause: error });
    });
  const resolvedRoots = allowedRoots.map((root) => path.resolve(root));
  if (!resolvedRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
    throw new BadRequestError("image-path is outside the allowed workspace/runtime/data directories.");
  }
  const info = await stat(real);
  if (!info.isFile()) throw new BadRequestError(`image-path not found: ${imagePath}`);
  if (info.size <= 0) throw new BadRequestError("image-path is empty.");
  if (info.size > MAX_IMAGE_BYTES) throw new BadRequestError("image-path is too large (max 20 MiB).");
  return real;
}

