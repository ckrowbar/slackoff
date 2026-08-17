import type { ImageInput } from "../protocol.js";
import { MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUTS, SUPPORTED_IMAGE_MIME_TYPES } from "../image-inputs.js";

export { MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUTS } from "../image-inputs.js";

const SUPPORTED_DECLARED_MIME_TYPES = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_MAGIC = Buffer.from("GIF87a", "ascii");
const GIF89A_MAGIC = Buffer.from("GIF89a", "ascii");
const RIFF_MAGIC = Buffer.from("RIFF", "ascii");
const WEBP_MAGIC = Buffer.from("WEBP", "ascii");


export interface SlackImageFile {
  id: string;
  name?: string | null | undefined;
  title?: string | null | undefined;
  mimetype: string;
  size: number;
  url_private?: string | undefined;
  url_private_download?: string | undefined;
}

export interface RejectedSlackImage {
  name: string;
  reason: string;
}

export interface SlackImageDownloadResult {
  images: ImageInput[];
  rejected: RejectedSlackImage[];
}

export async function downloadSlackImages(
  files: readonly SlackImageFile[],
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackImageDownloadResult> {
  const images: ImageInput[] = [];
  const rejected: RejectedSlackImage[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const name = file.name || file.title || file.id;
    if (images.length === MAX_IMAGE_INPUTS) {
      rejected.push({ name, reason: `only ${MAX_IMAGE_INPUTS} images are supported per message` });
      continue;
    }
    if (!SUPPORTED_DECLARED_MIME_TYPES.has(file.mimetype.toLowerCase())) {
      rejected.push({ name, reason: `unsupported image type ${file.mimetype || "unknown"}` });
      continue;
    }

    const remainingBytes = MAX_IMAGE_INPUT_BYTES - totalBytes;
    if (file.size > remainingBytes) {
      rejected.push({ name, reason: "the message exceeds the 20 MB image limit" });
      continue;
    }
    const url = file.url_private_download || file.url_private;
    if (!url) {
      rejected.push({ name, reason: "Slack did not provide a download URL" });
      continue;
    }
    if (!isTrustedSlackFileUrl(url)) {
      rejected.push({ name, reason: "Slack provided an invalid download URL" });
      continue;
    }

    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: "error",
        credentials: "omit",
      });
      if (!response.ok) {
        rejected.push({ name, reason: `Slack download failed with HTTP ${response.status}` });
        continue;
      }
      const bytes = await readBoundedBody(response, remainingBytes);
      const mimeType = detectImageMimeType(bytes);
      if (!mimeType) {
        rejected.push({ name, reason: "downloaded content is not a supported image" });
        continue;
      }
      totalBytes += bytes.byteLength;
      images.push({ data: bytes.toString("base64"), mimeType });
    } catch (error) {
      rejected.push({
        name,
        reason: error instanceof ImageLimitError ? error.message : "Slack image download failed",
      });
    }
  }

  return { images, rejected };
}

class ImageLimitError extends Error {}

function isTrustedSlackFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (hostname === "slack.com" || hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ImageLimitError("the message exceeds the 20 MB image limit");
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new ImageLimitError("the message exceeds the 20 MB image limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytesRead);
}

function detectImageMimeType(bytes: Uint8Array): ImageInput["mimeType"] | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, PNG_MAGIC.byteLength).equals(PNG_MAGIC)) return "image/png";
  if (buffer.subarray(0, JPEG_MAGIC.byteLength).equals(JPEG_MAGIC)) return "image/jpeg";
  if (
    buffer.subarray(0, GIF87A_MAGIC.byteLength).equals(GIF87A_MAGIC) ||
    buffer.subarray(0, GIF89A_MAGIC.byteLength).equals(GIF89A_MAGIC)
  ) {
    return "image/gif";
  }
  if (
    buffer.subarray(0, RIFF_MAGIC.byteLength).equals(RIFF_MAGIC) &&
    buffer.subarray(8, 8 + WEBP_MAGIC.byteLength).equals(WEBP_MAGIC)
  ) {
    return "image/webp";
  }
  return undefined;
}
