/**
 * Client-side image compression → WebP.
 *
 * The admin panel converts every uploaded photo to WebP right in the browser
 * (canvas.toBlob), so the worker only ever stores a small, optimized image.
 * No server-side image processing needed — free on GitHub Pages + Workers.
 */

export const IMAGE_MAX_DIM = 1400; // longest side, px
export const IMAGE_QUALITY = 0.82; // WebP quality 0–1

/**
 * Compress an image file to a WebP blob.
 * @param {File|Blob} file
 * @param {{maxDim?: number, quality?: number}} [opts]
 * @returns {Promise<{blob: Blob, width: number, height: number, originalBytes: number, compressedBytes: number}>}
 */
export async function compressImageToWebp(file, opts = {}) {
  const maxDim = opts.maxDim || IMAGE_MAX_DIM;
  const quality = opts.quality ?? IMAGE_QUALITY;

  const bitmap = await loadBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDim);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  // Soft white background so transparent PNGs don't become black on export.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);

  if (typeof bitmap.close === "function") bitmap.close();

  const blob = await canvasToBlob(canvas, "image/webp", quality);
  return {
    blob,
    width,
    height,
    originalBytes: file.size,
    compressedBytes: blob.size,
  };
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* fall through to <img> path */
    }
  }
  return loadViaImage(file);
}

function loadViaImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image."));
    };
    img.src = url;
  });
}

function fitWithin(w, h, maxDim) {
  if (w <= maxDim && h <= maxDim) return { width: w, height: h };
  const ratio = Math.min(maxDim / w, maxDim / h);
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
  };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("WebP export failed."))),
      type,
      quality
    );
  });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
