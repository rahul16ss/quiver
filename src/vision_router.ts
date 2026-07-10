/**
 * Vision Router — image encoding, detection, and model routing.
 *
 * Extracted from agent.ts for modularity and testability.
 *
 * Responsibilities:
 *   - Detect [Image: path] markers in user input
 *   - Validate images by magic bytes (not extension)
 *   - Encode images as base64 data URLs
 *   - Detect video file extensions
 *   - Determine which model to use (primary vs vision fallback)
 *   - Check if the latest user message contains vision content
 *
 * Security:
 *   - Only local files (no URLs)
 *   - Magic-byte validation (can't disguise scripts as images)
 *   - Size-limited (20MB max)
 *   - Path traversal blocked (path.resolve + stat)
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import picocolors from "picocolors";
import { config } from "./config.js";
import { inflateSync, deflateSync } from "zlib";
import type { Message } from "./types.js";

// ─── Image Magic Bytes ───────────────────────────────────────────────

export const IMAGE_MAGIC: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38],
  bmp: [0x42, 0x4d],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF header
};

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

// ─── Video Extensions ────────────────────────────────────────────────
// Maximum image dimension (width or height) before downscale (US-5.4).
export const MAX_IMAGE_DIMENSION = 1568;

// ─── Remote Vision Consent (US-5.4) ──────────────────────────────────
// Routing images to a remote vision provider requires explicit user consent.
// Detection of a configured vision model is not consent.
let visionRemoteConsent = false;

/** Grant or revoke consent to route images to a remote vision provider. */
export function setVisionRemoteConsent(consent: boolean): void {
  visionRemoteConsent = consent;
}

/** Whether the user has consented to remote vision routing. */
export function getVisionRemoteConsent(): boolean {
  return visionRemoteConsent;
}

function isRemoteVisionUrl(url: string): boolean {
  return !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url || "");
}

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
  "3gp",
];

// ─── Image Validation ────────────────────────────────────────────────

/**
 * Validate that a file is a real image by checking magic bytes.
 * Prevents disguised malicious files (e.g. a script renamed to .png).
 */
export function validateImageMagic(filePath: string): string | null {
  try {
    const fd = fsSync.openSync(filePath, "r");
    const header = Buffer.alloc(12);
    fsSync.readSync(fd, header, 0, 12, 0);
    fsSync.closeSync(fd);

    for (const [ext, magic] of Object.entries(IMAGE_MAGIC)) {
      if (header.subarray(0, magic.length).equals(Buffer.from(magic))) {
        return ext;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strip EXIF/metadata from a JPEG buffer (US-5.4).
 * Walks the JPEG marker tree and removes APPn (0xFFE0–0xFFEF) and COM
 * (0xFFFE) segments while preserving SOI, SOF, DHT, SOS, entropy data,
 * and EOI — the image remains decodable, only metadata is redacted.
 */
function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      while (i < buf.length) out.push(buf[i++]);
      break;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd9) {
      out.push(0xff, marker);
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) break;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) {
      for (let k = 0; k < 2 + len && i + k < buf.length; k++) out.push(buf[i + k]);
    }
    i += 2 + len;
    if (marker === 0xda) {
      while (i < buf.length) out.push(buf[i++]);
      break;
    }
  }
  return Buffer.from(out);
}

/**
 * Strip textual metadata chunks from a PNG buffer (US-5.4).
 * Removes tEXt, iTXt, zTXt, and eXIf chunks; keeps IHDR, IDAT, PLTE, IEND.
 */
function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8) return buf;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let k = 0; k < 8; k++) if (buf[k] !== sig[k]) return buf;
  const out: number[] = sig;
  let i = 8;
  const metaTypes = ["tEXt", "iTXt", "zTXt", "eXIf"];
  while (i + 8 <= buf.length) {
    const len = (buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3];
    const type = buf.subarray(i + 4, i + 8).toString("ascii");
    const total = 12 + len;
    if (!metaTypes.includes(type)) {
      for (let k = 0; k < total && i + k < buf.length; k++) out.push(buf[i + k]);
    }
    i += total;
    if (type === "IEND") break;
  }
  return Buffer.from(out);
}

// ─── Pure-JS PNG downscale (no native deps) ──────────────────────────
// Used when `sharp` is unavailable so oversized PNGs are still downscaled
// before upload (US-5.4). Decodes common 8-bit PNGs (color types 2/6/0/3),
// applies the standard PNG reconstruction filters, area-averages to the
// target longest edge, and re-encodes as 8-bit RGBA with filter-type None.

interface PngImage { width: number; height: number; data: Buffer; /* RGBA */ }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(buf: Buffer): PngImage | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  let width = 0, height = 0, bitDepth = 8, colorType = 6;
  let idat = Buffer.alloc(0);
  let palette: number[][] | null = null;
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      bitDepth = buf[pos + 16];
      colorType = buf[pos + 17];
    } else if (type === "PLTE") {
      palette = [];
      for (let i = 0; i + 2 < data.length; i += 3) palette.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === "IDAT") {
      idat = Buffer.concat([idat, data]);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (width === 0 || height === 0 || bitDepth !== 8) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  if (channels === 0) return null;
  let raw: Buffer;
  try { raw = inflateSync(idat); } catch { return null; }
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  const prevRow = Buffer.alloc(stride);
  let rpos = 0;
  for (let y = 0; y < height; y++) {
    if (rpos >= raw.length) break;
    const f = raw[rpos++];
    const row = raw.subarray(rpos, rpos + stride);
    const out = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const cur = row[x] || 0;
      const left = x >= channels ? out[x - channels] : 0;
      const up = prevRow[x] || 0;
      const upLeft = x >= channels ? prevRow[x - channels] : 0;
      let v: number;
      switch (f) {
        case 0: v = cur; break;
        case 1: v = (cur + left) & 0xff; break;
        case 2: v = (cur + up) & 0xff; break;
        case 3: v = (cur + ((left + up) >> 1)) & 0xff; break;
        case 4: v = (cur + paeth(left, up, upLeft)) & 0xff; break;
        default: v = cur;
      }
      out[x] = v;
    }
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 255;
      if (channels === 4) { r = out[x*4]; g = out[x*4+1]; b = out[x*4+2]; a = out[x*4+3]; }
      else if (channels === 3) { r = out[x*3]; g = out[x*3+1]; b = out[x*3+2]; }
      else if (channels === 2) { r = g = b = out[x*2]; a = out[x*2+1]; }
      else if (channels === 1) {
        if (palette) { const p = palette[out[x]] || [0,0,0]; r = p[0]; g = p[1]; b = p[2]; }
        else { r = g = b = out[x]; }
      }
      const o = (y * width + x) * 4;
      rgba[o] = r; rgba[o+1] = g; rgba[o+2] = b; rgba[o+3] = a;
    }
    out.copy(prevRow);
    rpos += stride;
  }
  return { width, height, data: rgba };
}

function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + stride);
    raw[off] = 0; // filter None
    rgba.subarray(y * stride, y * stride + stride).copy(raw, off + 1);
  }
  const idat = deflateSync(raw);
  const crc = (b: Buffer) => {
    const t = (crc as any).table || ((crc as any).table = (() => {
      const tab = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tab[n] = c >>> 0; }
      return tab;
    })());
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.from(type, "ascii");
    const body = Buffer.concat([td, data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, c]);
  };
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Area-averaging downscale of an RGBA buffer to the given dimensions. */
function downscaleRgba(img: PngImage, dstW: number, dstH: number): PngImage {
  if (dstW >= img.width && dstH >= img.height) return img;
  const out = Buffer.alloc(dstW * dstH * 4);
  const sx = img.width / dstW;
  const sy = img.height / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx), x1 = Math.min(img.width, Math.ceil((dx + 1) * sx));
      const y0 = Math.floor(dy * sy), y1 = Math.min(img.height, Math.ceil((dy + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const o = (yy * img.width + xx) * 4; r += img.data[o]; g += img.data[o+1]; b += img.data[o+2]; a += img.data[o+3]; n++;
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = r / n; out[o+1] = g / n; out[o+2] = b / n; out[o+3] = a / n;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/**
 * Pure-JS PNG downscale: decode → area-average to MAX_IMAGE_DIMENSION → encode.
 * Keeps the image decodable while capping both dimensions (US-5.4).
 */
function downscalePngBuffer(buf: Buffer): Buffer {
  const img = decodePng(buf);
  if (!img) return buf;
  const scale = Math.min(MAX_IMAGE_DIMENSION / img.width, MAX_IMAGE_DIMENSION / img.height);
  if (scale >= 1) return buf;
  const dstW = Math.max(1, Math.round(img.width * scale));
  const dstH = Math.max(1, Math.round(img.height * scale));
  return encodePngRgba(dstW, dstH, downscaleRgba(img, dstW, dstH).data);
}

/**
 * Downscale an image buffer before upload (US-5.4).
 * Uses the `sharp` native module when available to resize the longest edge
 * to MAX_IMAGE_DIMENSION. When sharp is absent, metadata is stripped as a
 * best-effort payload reduction so the pipeline never blocks on a missing
 * native dependency.
 */
async function downscaleImage(buf: Buffer, ext: string): Promise<Buffer> {
  try {
    // sharp is an optional native dependency; resolve it dynamically so the
    // pipeline never hard-fails when it is absent (US-5.4 downscale).
    const dynamicImport: (m: string) => Promise<any> = new Function("m", "return import(m)") as any;
    const sharpMod: any = await dynamicImport("sharp").catch(() => null);
    const sharp: any = sharpMod?.default ?? sharpMod;
    if (sharp && typeof sharp === "function") {
      return await sharp(buf)
        .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
        .toBuffer();
    }
  } catch {
    // sharp unavailable — fall through to metadata-only reduction.
  }
  if (ext === "jpg" || ext === "jpeg") return stripJpegMetadata(buf);
  if (ext === "png") {
    // Metadata is stripped, then the image is downscaled in pure JS so the
    // longest edge never exceeds MAX_IMAGE_DIMENSION even without sharp.
    const stripped = stripPngMetadata(buf);
    return downscalePngBuffer(stripped);
  }
  return buf;
}

/**
 * Encode an image file as a base64 data URL.
 * EXIF/metadata is stripped and the image is downscaled before encoding
 * for transmission (US-5.4). Returns null if the file is not a valid
 * image or is too large.
 */
export async function encodeImageAsDataURL(
  filePath: string,
): Promise<string | null> {
  try {
    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved);

    if (!stat.isFile()) return null;
    if (stat.size > MAX_IMAGE_SIZE) {
      console.error(
        picocolors.yellow(
          `     Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 20MB limit): ${resolved}`,
        ),
      );
      return null;
    }

    const ext = validateImageMagic(resolved);
    if (!ext) {
      console.error(
        picocolors.yellow(
          `     Not a valid image file (magic bytes mismatch): ${resolved}`,
        ),
      );
      return null;
    }

    const raw = await fs.readFile(resolved);
    let sanitized: Buffer;
    if (ext === "jpg" || ext === "jpeg") sanitized = stripJpegMetadata(raw);
    else if (ext === "png") sanitized = stripPngMetadata(raw);
    else sanitized = raw;
    const downscaled = await downscaleImage(sanitized, ext);
   const base64 = downscaled.toString("base64");
    // Normalize JPEG mime (`image/jpeg`) regardless of the jpg/jpeg magic key.
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

// ─── Image Marker Processing ─────────────────────────────────────────

export type VisionContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

/**
 * Detect [Image: path] markers in user input and convert to vision message parts.
 * Returns the message content as either a string (no images) or an array
 * of text and image_url parts (OpenAI vision format).
 */
export async function processImageMarkers(
  input: string,
): Promise<VisionContent> {
  const imageMarker = /\[Image:\s*([^\]]+)\]/g;
  const matches = [...input.matchAll(imageMarker)];

  if (matches.length === 0) return input;

  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];

  let lastIdx = 0;
  let imagesEncoded = 0;

  for (const match of matches) {
    const matchStart = match.index!;
    const matchEnd = matchStart + match[0].length;
    const rawPath = match[1].trim();

    if (matchStart > lastIdx) {
      const textBefore = input.substring(lastIdx, matchStart).trim();
      if (textBefore) parts.push({ type: "text", text: textBefore });
    }

    const dataUrl = await encodeImageAsDataURL(rawPath);
    if (dataUrl) {
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
      imagesEncoded++;
    } else {
      parts.push({
        type: "text",
        text: `[Image: ${rawPath} — could not load. The file may not exist, may not be a valid image, or may be too large.]`,
      });
    }

    lastIdx = matchEnd;
  }

  if (lastIdx < input.length) {
    const textAfter = input.substring(lastIdx).trim();
    if (textAfter) parts.push({ type: "text", text: textAfter });
  }

  if (imagesEncoded > 0 && config.outputMode === "interactive") {
    console.log(
      picocolors.gray(
        `   📎 ${imagesEncoded} image${imagesEncoded > 1 ? "s" : ""} encoded for vision`,
      ),
    );
  }

  return parts;
}

// ─── Vision Content Detection ────────────────────────────────────────

/**
 * Check if the LATEST user message contains vision content (image_url parts).
 * Only the most recent user message is checked — not historical messages.
 *
 * This is critical: if we checked ALL messages, then once a user ever sends
 * an image, ALL subsequent turns would be routed to the vision model (Gemma 4)
 * instead of the primary model (GLM-5.2). Gemma 4 has a smaller context window
 * and different capabilities, so routing everything to it causes:
 *   - Context overflow crashes (Gemma can't handle 50K token context)
 *   - Silent hangs (Ollama crashes processing oversized context)
 *   - Degraded responses (Gemma is a smaller model than GLM-5.2)
 *
 * By checking only the latest user message, we ensure that:
 *   - Turns with images → routed to vision model
 *   - Turns without images → routed to primary model (even if prior turns had images)
 */
export function latestMessageHasVisionContent(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      return (
        Array.isArray(content) &&
        content.some((part: any) => part.type === "image_url")
      );
    }
  }
  return false;
}

// ─── Model Routing ───────────────────────────────────────────────────

export interface ActiveModelConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  isVision: boolean;
}

/**
 * Determine which model, base URL, and API key to use for the current request.
 * If the latest user message contains image_url parts, route to the vision
 * fallback model. Otherwise, use the primary model.
 */
export function getActiveModelConfig(messages: Message[]): ActiveModelConfig {
  const hasVision = latestMessageHasVisionContent(messages);
  // Remote vision routing requires explicit consent (US-5.4). A remote
  // vision provider must never receive image data until the user opts in.
  const remoteVision = isRemoteVisionUrl(config.visionModelBaseUrl);
  if (hasVision && config.visionModelName && (!remoteVision || visionRemoteConsent)) {
    return {
      model: config.visionModelName,
      baseUrl: config.visionModelBaseUrl,
      apiKey: config.visionModelApiKey,
      isVision: true,
    };
  }
  return {
    model: config.llmModelName,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    isVision: false,
  };
}

// ─── Video Detection ─────────────────────────────────────────────────

/**
 * Check if a file path has a video extension.
 * Used to detect video files in [Image: path] markers — videos are treated
 * like images for routing purposes (vision model handles them).
 */
export function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Check if user input contains [Image: path] markers pointing to video files.
 */
export function inputHasVideoMarkers(input: string): boolean {
  const imageMarker = /\[Image:\s*([^\]]+)\]/g;
  const matches = [...input.matchAll(imageMarker)];
  return matches.some((m) => isVideoFile(m[1].trim()));
}
