// Inline images for HTML mail (charts, logos). The agent names files by path, so this is a file-read
// primitive driven by a model: it is locked down to allow-listed folders, image types, and small sizes.
import { open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InlineImage, LoadedImage, ValidatedMail } from "./mail.js";

export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_TOTAL_IMAGE_BYTES = 6_000_000;

/** Folders images may be read from when `inlineImageRoots` is not configured: the coach plugin's charts. */
export function defaultImageRoots(home = os.homedir()): string[] {
  return [path.join(home, ".openclaw", "coach", "charts")];
}

function kind(head: Buffer): "image/png" | "image/jpeg" | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  return null;
}

/** Reads the requested images, refusing anything outside the roots, oversized, or not really an image. */
export async function loadInlineImages(requests: readonly InlineImage[], roots: readonly string[]): Promise<{ ok: true; images: LoadedImage[] } | { ok: false; error: string }> {
  if (requests.length === 0) return { ok: true, images: [] };
  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // A root that does not exist yet allows nothing.
    }
  }
  const images: LoadedImage[] = [];
  let total = 0;
  for (const request of requests) {
    let real: string;
    try {
      real = await realpath(path.resolve(request.path));
    } catch {
      return { ok: false, error: `inline image ${request.cid}: file not found` };
    }
    if (!realRoots.some((root) => real === root || real.startsWith(root + path.sep))) {
      return { ok: false, error: `inline image ${request.cid}: the file is outside the allowed folders (inlineImageRoots)` };
    }
    const handle = await open(real, "r").catch(() => null);
    if (!handle) return { ok: false, error: `inline image ${request.cid}: file cannot be read` };
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { ok: false, error: `inline image ${request.cid}: not a regular file` };
      if (info.size > MAX_IMAGE_BYTES) return { ok: false, error: `inline image ${request.cid}: larger than ${MAX_IMAGE_BYTES} bytes` };
      const content = await handle.readFile();
      const contentType = kind(content);
      if (!contentType) return { ok: false, error: `inline image ${request.cid}: not a PNG or JPEG file` };
      total += content.length;
      if (total > MAX_TOTAL_IMAGE_BYTES) return { ok: false, error: `inline images exceed ${MAX_TOTAL_IMAGE_BYTES} bytes in total` };
      images.push({ cid: request.cid, filename: path.basename(real), contentType, content });
    } finally {
      await handle.close();
    }
  }
  return { ok: true, images };
}

/** Resolves the images of a validated mail in place of its requests. */
export async function withLoadedImages(mail: ValidatedMail, roots: readonly string[]): Promise<{ ok: true; mail: ValidatedMail } | { ok: false; error: string }> {
  const loaded = await loadInlineImages(mail.inlineImages, roots);
  return loaded.ok ? { ok: true, mail: { ...mail, images: loaded.images } } : loaded;
}
