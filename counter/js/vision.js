/**
 * In-browser motorcycle-part classifier (AswinG5/moto-parts-30cls).
 * Ultralytics YOLOv8-cls → ONNX Runtime Web.
 *
 * Preprocess matches ultralytics classify_transforms(224):
 * RGB → Resize(shorter edge = imgsz, bilinear) → CenterCrop(imgsz)
 * → CHW float32 / 255, mean 0 std 1 (no ImageNet normalize).
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

let ortMod = null;
let session = null;
let meta = null;
let loadedProvider = null;

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

/** Torchvision Resize(int) + CenterCrop(int), then CHW float32 0–1. */
function preprocess(imageSource, imgsz, mean, std) {
  const { w: srcW, h: srcH } = sourceSize(imageSource);
  if (!srcW || !srcH) throw new Error("empty image");

  let rw;
  let rh;
  if (srcW <= srcH) {
    rw = imgsz;
    rh = Math.trunc((imgsz * srcH) / srcW);
  } else {
    rh = imgsz;
    rw = Math.trunc((imgsz * srcW) / srcH);
  }

  const canvas = document.createElement("canvas");
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imageSource, 0, 0, rw, rh);

  const sx = Math.round((rw - imgsz) / 2);
  const sy = Math.round((rh - imgsz) / 2);
  const { data } = ctx.getImageData(sx, sy, imgsz, imgsz);

  const hw = imgsz * imgsz;
  const tensor = new Float32Array(3 * hw);
  for (let i = 0; i < hw; i++) {
    const o = i * 4;
    tensor[i] = (data[o] / 255 - mean[0]) / std[0];
    tensor[hw + i] = (data[o + 1] / 255 - mean[1]) / std[1];
    tensor[2 * hw + i] = (data[o + 2] / 255 - mean[2]) / std[2];
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

function topK(probs, k, classes, map) {
  const idx = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]);
  const n = Math.min(k, idx.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const className = classes[idx[i]];
    const partId = Object.prototype.hasOwnProperty.call(map, className)
      ? map[className]
      : null;
    out.push({ className, partId, score: probs[idx[i]] });
  }
  return out;
}

/**
 * Lazy-load ORT + the ONNX weights. Default EP is WASM (numThreads=1 when
 * SharedArrayBuffer / cross-origin isolation is missing). Pass
 * { executionProviders: ["webgpu", "wasm"] } to try WebGPU first.
 */
export async function loadPartModel(onProgress, opts = {}) {
  if (session && meta) {
    progress(onProgress, 1, loadedProvider);
    return { provider: loadedProvider, meta };
  }

  const wantGpu = (opts.executionProviders || ["wasm"]).includes("webgpu");
  progress(onProgress, 0.05, "ort");
  ortMod = await loadOrt(wantGpu);
  progress(onProgress, 0.2, "ort");

  const [modelBuf, classesJson] = await Promise.all([
    fetchWithProgress(MODEL_URL, onProgress, [0.2, 0.85]),
    fetch(CLASSES_URL).then((r) => {
      if (!r.ok) throw new Error(`classes.json ${r.status}`);
      return r.json();
    }),
  ]);
  meta = classesJson;

  const providers = opts.executionProviders || ["wasm"];
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
    throw lastErr || new Error("no execution provider worked");
  }

  const imgsz = meta.imgsz || 224;
  const zeros = new Float32Array(3 * imgsz * imgsz);
  const t = new ortMod.Tensor("float32", zeros, [1, 3, imgsz, imgsz]);
  await session.run({ [session.inputNames[0]]: t });
  progress(onProgress, 1, loadedProvider);
  return { provider: loadedProvider, meta };
}

export function partModelInfo() {
  return { provider: loadedProvider, meta, ready: Boolean(session) };
}

/** @param {HTMLImageElement | HTMLCanvasElement | ImageBitmap} imageSource */
export async function classifyPart(imageSource) {
  if (!session || !meta) await loadPartModel();
  const img = await ensureImage(imageSource);
  const imgsz = meta.imgsz || 224;
  const mean = meta.normalize?.mean || [0, 0, 0];
  const std = meta.normalize?.std || [1, 1, 1];
  const chw = preprocess(img, imgsz, mean, std);
  const input = new ortMod.Tensor("float32", chw, [1, 3, imgsz, imgsz]);
  const t0 = performance.now();
  const out = await session.run({ [session.inputNames[0]]: input });
  const ms = performance.now() - t0;
  const raw = out[session.outputNames[0]].data;
  const probs = toProbs(raw);
  const top = topK(probs, 5, meta.classes, meta.map || {});
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
