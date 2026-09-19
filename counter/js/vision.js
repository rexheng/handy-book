/**
 * In-browser motorcycle-part classifier (AswinG5/moto-parts-30cls).
 * Ultralytics YOLOv8-cls → ONNX Runtime Web.
 *
 * Preprocess matches ultralytics classify_transforms(224):
 * RGB → Resize(shorter edge = imgsz, bilinear + antialias, Pillow triangle
 * filter) → CenterCrop(imgsz) → CHW float32 / 255, mean 0 std 1.
 *
 * classifyPart(imageSource) → top-5 of
 *   { className, score, partIds, partId, ambiguous? }
 *   partIds  — catalog ids from classes.json `map` (always an array)
 *   partId   — set only when partIds.length === 1 AND score >= 0.35;
 *              otherwise null (multi-id classes such as brake_pad, and
 *              low-confidence rows, never auto-resolve)
 *   ambiguous — true when classes.json lists the class (brake_clutch_lever:
 *              mapped to clutch-lever; catalog has no brake-lever id)
 *
 * loadPartModel(options) resolves to { provider, meta }. Recreates the
 * InferenceSession when executionProviders change. A function as the first
 * argument is treated as onProgress (legacy).
 */

const ORT_WASM =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.wasm.min.mjs";
const ORT_WEBGPU =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.webgpu.bundle.min.mjs";
const ORT_WASM_PATHS =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";

const MODEL_URL = new URL(
  "../../store/model/moto-parts-30cls.onnx",
  import.meta.url
).href;
const CLASSES_URL = new URL(
  "../../store/model/classes.json",
  import.meta.url
).href;

/** Auto-resolve catalog id only at/above this softmax score, and only if unique. */
const SCORE_FLOOR = 0.35;

const PRECISION_BITS = 22;

let ortMod = null;
let session = null;
let meta = null;
let loadedProvider = null;
let requestedEpKey = null;
let modelBuf = null;

function progress(onProgress, value, detail) {
  if (typeof onProgress === "function") onProgress(value, detail);
}

function hasSharedArrayBuffer() {
  try {
    return typeof SharedArrayBuffer === "function" && self.crossOriginIsolated;
  } catch {
    return false;
  }
}

function epKey(providers) {
  return (providers && providers.length ? providers : ["wasm"]).join(",");
}

function parseLoadArgs(options, extra) {
  if (typeof options === "function") {
    return { onProgress: options, ...(extra || {}) };
  }
  return options && typeof options === "object" ? options : {};
}

async function loadOrt(preferWebgpu) {
  const urls = preferWebgpu ? [ORT_WEBGPU, ORT_WASM] : [ORT_WASM];
  let lastErr;
  for (const url of urls) {
    try {
      const mod = await import(url);
      const ort = mod.default ?? mod;
      ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
      if (!hasSharedArrayBuffer()) {
        ort.env.wasm.numThreads = 1;
      }
      return ort;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("onnxruntime-web failed to load");
}

async function fetchWithProgress(url, onProgress, span) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    progress(onProgress, span[1], "model");
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  const [a, b] = span;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    progress(onProgress, a + (b - a) * (loaded / total), "model");
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

function sourceSize(imageSource) {
  if (imageSource instanceof HTMLImageElement) {
    return {
      w: imageSource.naturalWidth || imageSource.width,
      h: imageSource.naturalHeight || imageSource.height,
    };
  }
  return { w: imageSource.width, h: imageSource.height };
}

async function ensureImage(imageSource) {
  if (imageSource instanceof HTMLImageElement && !imageSource.complete) {
    await imageSource.decode();
  }
  return imageSource;
}

/** Python 3 round-half-even (torchvision CenterCrop uses round()). */
function pyRound(x) {
  const n = Math.floor(x);
  const f = x - n;
  if (f < 0.5) return n;
  if (f > 0.5) return n + 1;
  return n % 2 === 0 ? n : n + 1;
}

/**
 * Pillow bilinear (triangle, support=1) coefficients.
 * Port of precompute_coeffs in Pillow 11 libImaging/Resample.c.
 */
function pillowCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = scale < 1 ? 1 : scale;
  const support = filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Float64Array(outSize * ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    const kOff = xx * ksize;
    for (let x = 0; x < xmax; x++) {
      const t = (x + xmin - center + 0.5) * ss;
      const at = t < 0 ? -t : t;
      const w = at < 1 ? 1 - at : 0;
      kk[kOff + x] = w;
      ww += w;
    }
    if (ww !== 0) {
      for (let x = 0; x < xmax; x++) kk[kOff + x] /= ww;
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { bounds, kk, ksize };
}

function normalizeCoeffs8(kk, n) {
  const scale = 1 << PRECISION_BITS;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const w = kk[i];
    out[i] = w < 0 ? Math.trunc(w * scale - 0.5) : Math.trunc(w * scale + 0.5);
  }
  return out;
}

function clip8(ss) {
  const v = Math.floor(ss / (1 << PRECISION_BITS));
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

/** Two-pass Pillow bilinear resize of an RGBA buffer. */
function pillowBilinearResize(src, srcW, srcH, dstW, dstH) {
  let data = src;
  let w = srcW;
  let h = srcH;
  const bias = 1 << (PRECISION_BITS - 1);

  if (dstW !== srcW) {
    const { bounds, kk, ksize } = pillowCoeffs(srcW, dstW);
    const ki = normalizeCoeffs8(kk, dstW * ksize);
    const next = new Uint8ClampedArray(dstW * h * 4);
    for (let yy = 0; yy < h; yy++) {
      const sRow = yy * srcW * 4;
      const dRow = yy * dstW * 4;
      for (let xx = 0; xx < dstW; xx++) {
        const xmin = bounds[xx * 2];
        const xmax = bounds[xx * 2 + 1];
        const kOff = xx * ksize;
        let r = bias;
        let g = bias;
        let b = bias;
        let a = bias;
        for (let x = 0; x < xmax; x++) {
          const k = ki[kOff + x];
          const o = sRow + (x + xmin) * 4;
          r += data[o] * k;
          g += data[o + 1] * k;
          b += data[o + 2] * k;
          a += data[o + 3] * k;
        }
        const d = dRow + xx * 4;
        next[d] = clip8(r);
        next[d + 1] = clip8(g);
        next[d + 2] = clip8(b);
        next[d + 3] = clip8(a);
      }
    }
    data = next;
    w = dstW;
  }

  if (dstH !== srcH) {
    const { bounds, kk, ksize } = pillowCoeffs(h, dstH);
    const ki = normalizeCoeffs8(kk, dstH * ksize);
    const next = new Uint8ClampedArray(w * dstH * 4);
    for (let yy = 0; yy < dstH; yy++) {
      const ymin = bounds[yy * 2];
      const ymax = bounds[yy * 2 + 1];
      const kOff = yy * ksize;
      const dRow = yy * w * 4;
      for (let xx = 0; xx < w; xx++) {
        let r = bias;
        let g = bias;
        let b = bias;
        let a = bias;
        for (let y = 0; y < ymax; y++) {
          const k = ki[kOff + y];
          const o = (y + ymin) * w * 4 + xx * 4;
          r += data[o] * k;
          g += data[o + 1] * k;
          b += data[o + 2] * k;
          a += data[o + 3] * k;
        }
        const d = dRow + xx * 4;
        next[d] = clip8(r);
        next[d + 1] = clip8(g);
        next[d + 2] = clip8(b);
        next[d + 3] = clip8(a);
      }
    }
    data = next;
    h = dstH;
  }

  return { data, w, h };
}

async function readRgba(imageSource) {
  const { w, h } = sourceSize(imageSource);
  if (!w || !h) throw new Error("empty image");

  let bmp = null;
  try {
    if (typeof createImageBitmap === "function") {
      bmp = await createImageBitmap(imageSource, {
        colorSpaceConversion: "none",
        resizeQuality: "high",
      });
    }
  } catch {
    bmp = null;
  }

  const src = bmp || imageSource;
  const sw = bmp ? bmp.width : w;
  const sh = bmp ? bmp.height : h;
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
    colorSpace: "srgb",
  });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0);
  const { data } = ctx.getImageData(0, 0, sw, sh);
  if (bmp && typeof bmp.close === "function") bmp.close();
  return { data, w: sw, h: sh };
}

/** Torchvision Resize(int) + CenterCrop(int), then CHW float32 0–1. */
async function preprocess(imageSource, imgsz, mean, std) {
  const rgba = await readRgba(imageSource);
  const srcW = rgba.w;
  const srcH = rgba.h;

  let rw;
  let rh;
  if (srcW <= srcH) {
    rw = imgsz;
    rh = Math.trunc((imgsz * srcH) / srcW);
  } else {
    rh = imgsz;
    rw = Math.trunc((imgsz * srcW) / srcH);
  }

  const resized = pillowBilinearResize(rgba.data, srcW, srcH, rw, rh);
  const sx = pyRound((resized.w - imgsz) / 2);
  const sy = pyRound((resized.h - imgsz) / 2);

  const hw = imgsz * imgsz;
  const tensor = new Float32Array(3 * hw);
  for (let y = 0; y < imgsz; y++) {
    const srcRow = ((y + sy) * resized.w + sx) * 4;
    for (let x = 0; x < imgsz; x++) {
      const i = y * imgsz + x;
      const o = srcRow + x * 4;
      tensor[i] = (resized.data[o] / 255 - mean[0]) / std[0];
      tensor[hw + i] = (resized.data[o + 1] / 255 - mean[1]) / std[1];
      tensor[2 * hw + i] = (resized.data[o + 2] / 255 - mean[2]) / std[2];
    }
  }
  return tensor;
}

function softmax(arr) {
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  const exps = new Float64Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const e = Math.exp(arr[i] - max);
    exps[i] = e;
    sum += e;
  }
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = exps[i] / sum;
  return out;
}

function toProbs(raw) {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Exported YOLOv8-cls graph already ends in Softmax.
  if (min >= 0 && Math.abs(sum - 1) < 0.05) return Float32Array.from(raw);
  return softmax(raw);
}

function partIdsFor(map, className) {
  const raw = map && Object.prototype.hasOwnProperty.call(map, className)
    ? map[className]
    : null;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((id) => typeof id === "string" && id);
  if (typeof raw === "string" && raw) return [raw];
  return [];
}

function isAmbiguous(metaObj, className) {
  const a = metaObj && metaObj.ambiguous;
  if (!a) return false;
  if (Array.isArray(a)) return a.includes(className);
  if (typeof a === "object") return Boolean(a[className]);
  return false;
}

function topK(probs, k, classes, map, metaObj) {
  const idx = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]);
  const n = Math.min(k, idx.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const className = classes[idx[i]];
    const score = probs[idx[i]];
    const partIds = partIdsFor(map, className);
    const partId =
      partIds.length === 1 && score >= SCORE_FLOOR ? partIds[0] : null;
    const row = { className, score, partIds, partId };
    if (isAmbiguous(metaObj, className)) row.ambiguous = true;
    out.push(row);
  }
  return out;
}

/**
 * Lazy-load ORT + the ONNX weights. Default EP is WASM (numThreads=1 when
 * SharedArrayBuffer / cross-origin isolation is missing). Pass
 * { executionProviders: ["webgpu", "wasm"] } to try WebGPU first.
 * Recreates the session when the requested provider list changes.
 *
 * @param {Function|{onProgress?: Function, executionProviders?: string[]}} [options]
 * @param {{executionProviders?: string[]}} [extra] when options is onProgress
 * @returns {Promise<{provider: string, meta: object}>}
 */
export async function loadPartModel(options = {}, extra = {}) {
  const opts = parseLoadArgs(options, extra);
  const onProgress = opts.onProgress;
  const providers = opts.executionProviders?.length
    ? opts.executionProviders
    : ["wasm"];
  const key = epKey(providers);

  if (session && meta && requestedEpKey === key) {
    progress(onProgress, 1, loadedProvider);
    return { provider: loadedProvider, meta };
  }

  if (session) {
    try {
      if (typeof session.release === "function") await session.release();
    } catch {
      /* ignore */
    }
    session = null;
    loadedProvider = null;
  }

  const wantGpu = providers.includes("webgpu");
  progress(onProgress, 0.05, "ort");
  ortMod = await loadOrt(wantGpu);
  progress(onProgress, 0.2, "ort");

  if (!modelBuf || !meta) {
    const [buf, classesJson] = await Promise.all([
      modelBuf
        ? Promise.resolve(modelBuf)
        : fetchWithProgress(MODEL_URL, onProgress, [0.2, 0.85]),
      meta
        ? Promise.resolve(meta)
        : fetch(CLASSES_URL).then((r) => {
            if (!r.ok) throw new Error(`classes.json ${r.status}`);
            return r.json();
          }),
    ]);
    modelBuf = buf;
    meta = classesJson;
  }

  let lastErr;
  for (const ep of providers) {
    try {
      progress(onProgress, 0.88, ep);
      session = await ortMod.InferenceSession.create(modelBuf, {
        executionProviders: [ep],
        graphOptimizationLevel: "all",
      });
      loadedProvider = ep;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      session = null;
    }
  }
  if (!session) {
    requestedEpKey = null;
    throw lastErr || new Error("no execution provider worked");
  }
  requestedEpKey = key;

  const imgsz = meta.imgsz || 224;
  const zeros = new Float32Array(3 * imgsz * imgsz);
  const t = new ortMod.Tensor("float32", zeros, [1, 3, imgsz, imgsz]);
  await session.run({ [session.inputNames[0]]: t });
  progress(onProgress, 1, loadedProvider);
  return { provider: loadedProvider, meta };
}

/** @param {HTMLImageElement | HTMLCanvasElement | ImageBitmap} imageSource */
export async function classifyPart(imageSource) {
  if (!session || !meta) await loadPartModel();
  const img = await ensureImage(imageSource);
  const imgsz = meta.imgsz || 224;
  const mean = meta.normalize?.mean || [0, 0, 0];
  const std = meta.normalize?.std || [1, 1, 1];
  const chw = await preprocess(img, imgsz, mean, std);
  const input = new ortMod.Tensor("float32", chw, [1, 3, imgsz, imgsz]);
  const t0 = performance.now();
  const out = await session.run({ [session.inputNames[0]]: input });
  const ms = performance.now() - t0;
  const raw = out[session.outputNames[0]].data;
  const probs = toProbs(raw);
  const top = topK(probs, 5, meta.classes, meta.map || {}, meta);
  top.ms = ms;
  return top;
}

/**
 * Bike photo-ID is not this model. AswinG5/moto-parts-30cls only has 30
 * part classes (no make/model). Identity of the bike stays with the roster
 * (typed name / aliases in query.js) and optional zero-shot. Always null.
 */
export async function identifyBike(imageSource, bikes) {
  void imageSource;
  void bikes;
  return null;
}
