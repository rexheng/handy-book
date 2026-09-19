import { state, set, go, emit, registerScreen } from "../bus.js";
import * as Q from "../query.js";

const SVG = "http://www.w3.org/2000/svg";
const SWIPE = 48;
const PINCH_MAX = 4;
const els = {};

let live = false;
let job = null;
let steps = [];
let index = 0;
let cropped = true;
let scale = 1;
let tx = 0;
let ty = 0;
const pointers = new Map();
let pinch0 = 1;
let scale0 = 1;
let pan0 = { x: 0, y: 0 };
let pt0 = { x: 0, y: 0 };
let didPinch = false;

function glyph(...ds) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ds) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "square");
    path.setAttribute("stroke-linejoin", "miter");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function preload(src) {
  if (!src) return;
  const img = new Image();
  img.decoding = "async";
  img.src = src;
}

function bounce() {
  const dest = state.bikeId ? "book" : "identify";
  queueMicrotask(() => go(dest, { replace: true }));
}

function pageOf(step) {
  if (step == null) return null;
  if (typeof step === "number") return step;
  const n = Number(step.page);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cropOf(step) {
  const raw = step && step.crop;
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [x, y, w, h] = raw.map(Number);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  return [x, y, w, h];
}

function stepsOf(rec) {
  return (rec.steps || []).filter((step) => pageOf(step) != null);
}

function labelPage(n) {
  return `p.${n}`;
}

function resetZoom() {
  scale = 1;
  tx = 0;
  ty = 0;
  pointers.clear();
  didPinch = false;
  if (els.zoom) els.zoom.style.transform = "";
}

function applyZoom() {
  if (!els.zoom) return;
  els.zoom.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

function closeOverlay() {
  if (!els.overlay || els.overlay.hidden) return;
  els.overlay.hidden = true;
  els.overImg.removeAttribute("src");
  els.overImg.alt = "";
}

function openOverlay(page) {
  const src = Q.pageUrl(job.manualId, page);
  els.overImg.loading = "lazy";
  els.overImg.decoding = "async";
  els.overImg.alt = labelPage(page);
  els.overImg.src = src;
  els.overlay.hidden = false;
  els.closeBtn.focus();
}

function publish(step) {
  const n = pageOf(step);
  set({ page: n });
  emit("page", { n });
}

function paintDots() {
  const n = steps.length;
  const row = els.dots;
  while (row.childNodes.length > n) row.removeChild(row.lastChild);
  while (row.childNodes.length < n) {
    const dot = document.createElement("i");
    dot.className = "dot";
    row.append(dot);
  }
  row.childNodes.forEach((dot, i) => {
    dot.classList.toggle("done", i < index);
    dot.classList.toggle("now", i === index);
  });
}

function paintRelated() {
  const list = Array.isArray(job.related) ? job.related : [];
  els.related.replaceChildren();
  if (!list.length) {
    els.related.hidden = true;
    return;
  }
  els.related.hidden = false;
  for (const item of list) {
    const page = pageOf(item);
    if (page == null) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "related-item";
    btn.addEventListener("click", () => openOverlay(page));

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = labelPage(page);
    img.src = Q.thumbUrl(job.manualId, page);
    img.addEventListener("load", () => {
      if (img.naturalWidth && img.naturalHeight) {
        btn.style.setProperty("--thumb-ar", String(img.naturalWidth / img.naturalHeight));
      }
    });

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.setAttribute("aria-hidden", "true");
    tag.textContent = labelPage(page);

    btn.append(img, tag);
    els.related.append(btn);
  }
}

function applyCrop(step) {
  const crop = cropped ? cropOf(step) : null;
  els.frame.classList.toggle("is-crop", Boolean(crop));
  els.cropBtn.hidden = !cropOf(step);
  els.cropBtn.setAttribute("aria-pressed", crop ? "true" : "false");
  if (crop) {
    const [x, y, w, h] = crop;
    els.frame.style.setProperty("--cx", String(x));
    els.frame.style.setProperty("--cy", String(y));
    els.frame.style.setProperty("--cw", String(w));
    els.frame.style.setProperty("--ch", String(h));
  } else {
    els.frame.style.removeProperty("--cx");
    els.frame.style.removeProperty("--cy");
    els.frame.style.removeProperty("--cw");
    els.frame.style.removeProperty("--ch");
  }
}

function show() {
  const step = steps[index];
  const page = pageOf(step);
  const n = steps.length;
  const src = Q.pageUrl(job.manualId, page);

  els.indexStamp.textContent = `${index + 1} / ${n}`;
  els.pageStamp.textContent = labelPage(page);
  els.pageImg.alt = labelPage(page);
  els.pageImg.src = src;
  applyCrop(step);
  paintDots();

  els.prevBtn.disabled = index <= 0;
  els.nextBtn.disabled = index >= n - 1;

  resetZoom();
  publish(step);

  const next = steps[index + 1];
  if (next) preload(Q.pageUrl(job.manualId, pageOf(next)));
}

function goStep(delta) {
  closeOverlay();
  const next = index + delta;
  if (next < 0 || next >= steps.length) return;
  index = next;
  cropped = true;
  show();
}

function onKey(event) {
  if (!live) return;
  if (event.key === "Escape") {
    if (!els.overlay.hidden) {
      event.preventDefault();
      closeOverlay();
    }
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    goStep(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    goStep(1);
  }
}

function onPointerDown(event) {
  if (!live || !els.overlay.hidden) return;
  if (event.button && event.button !== 0) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  try {
    els.frame.setPointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
  if (pointers.size === 1) {
    pt0 = { x: event.clientX, y: event.clientY };
    pan0 = { x: tx, y: ty };
    didPinch = false;
  } else if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    scale0 = scale;
    didPinch = true;
  }
}

function onPointerMove(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    scale = Math.min(PINCH_MAX, Math.max(1, scale0 * (dist / pinch0)));
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    applyZoom();
    didPinch = true;
    return;
  }
  if (scale > 1.01) {
    tx = pan0.x + (event.clientX - pt0.x);
    ty = pan0.y + (event.clientY - pt0.y);
    applyZoom();
  }
}

function onPointerUp(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  try {
    els.frame.releasePointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
  if (pointers.size === 0) {
    if (!didPinch && scale <= 1.01) {
      const dx = event.clientX - pt0.x;
      const dy = event.clientY - pt0.y;
      if (Math.abs(dx) >= SWIPE && Math.abs(dx) > Math.abs(dy)) {
        goStep(dx < 0 ? 1 : -1);
      }
    }
    if (scale < 1.02) resetZoom();
    return;
  }
  const rest = [...pointers.values()][0];
  pt0 = { x: rest.x, y: rest.y };
  pan0 = { x: tx, y: ty };
}

function onWheel(event) {
  if (!live || !els.overlay.hidden) return;
  event.preventDefault();
  const next = scale * (event.deltaY < 0 ? 1.12 : 0.9);
  scale = Math.min(PINCH_MAX, Math.max(1, next));
  if (scale === 1) {
    tx = 0;
    ty = 0;
  }
  applyZoom();
}

registerScreen("follow", {
  mount(root) {
    const progress = document.createElement("div");
    progress.className = "sheet follow-progress";

    const indexStamp = document.createElement("span");
    indexStamp.className = "stamp";

    const dots = document.createElement("div");
    dots.className = "dots";
    dots.setAttribute("aria-hidden", "true");

    const pageStamp = document.createElement("span");
    pageStamp.className = "stamp";

    progress.append(indexStamp, dots, pageStamp);

    const stage = document.createElement("div");
    stage.className = "stage";

    const frame = document.createElement("div");
    frame.className = "stage-frame";

    const zoom = document.createElement("div");
    zoom.className = "stage-zoom";

    const pageImg = document.createElement("img");
    pageImg.loading = "lazy";
    pageImg.decoding = "async";
    pageImg.alt = "";
    pageImg.addEventListener("load", () => {
      if (pageImg.naturalWidth && pageImg.naturalHeight) {
        frame.style.setProperty("--page-ar", String(pageImg.naturalWidth / pageImg.naturalHeight));
      }
    });

    zoom.append(pageImg);
    frame.append(zoom);

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "btn btn-icon nav-prev";
    prevBtn.setAttribute("aria-label", "Prev");
    prevBtn.append(glyph("M14.5 5 8 12l6.5 7"));
    prevBtn.addEventListener("click", () => goStep(-1));

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "btn btn-icon nav-next";
    nextBtn.setAttribute("aria-label", "Next");
    nextBtn.append(glyph("M9.5 5 16 12l-6.5 7"));
    nextBtn.addEventListener("click", () => goStep(1));

    const cropBtn = document.createElement("button");
    cropBtn.type = "button";
    cropBtn.className = "btn btn-icon crop-btn";
    cropBtn.setAttribute("aria-label", "Crop");
    cropBtn.hidden = true;
    cropBtn.append(glyph("M3 9V3h6", "M21 9V3h-6", "M3 15v6h6", "M21 15v6h-6"));
    cropBtn.addEventListener("click", () => {
      cropped = !cropped;
      applyCrop(steps[index]);
      resetZoom();
    });

    const overlay = document.createElement("div");
    overlay.className = "overlay card";
    overlay.hidden = true;

    const overImg = document.createElement("img");
    overImg.loading = "lazy";
    overImg.decoding = "async";
    overImg.alt = "";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn btn-icon overlay-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.append(glyph("M5 5l14 14M19 5 5 19"));
    closeBtn.addEventListener("click", closeOverlay);

    overlay.append(overImg, closeBtn);
    stage.append(frame, prevBtn, nextBtn, cropBtn, overlay);

    const related = document.createElement("div");
    related.className = "related";
    related.hidden = true;

    const partBtn = document.createElement("button");
    partBtn.type = "button";
    partBtn.className = "btn btn-primary part-btn";
    partBtn.textContent = "Part";
    partBtn.addEventListener("click", () => go("invoice"));

    root.append(progress, stage, related, partBtn);

    Object.assign(els, {
      indexStamp,
      dots,
      pageStamp,
      frame,
      zoom,
      pageImg,
      prevBtn,
      nextBtn,
      cropBtn,
      overlay,
      overImg,
      closeBtn,
      related,
    });

    frame.addEventListener("pointerdown", onPointerDown);
    frame.addEventListener("pointermove", onPointerMove);
    frame.addEventListener("pointerup", onPointerUp);
    frame.addEventListener("pointercancel", onPointerUp);
    frame.addEventListener("wheel", onWheel, { passive: false });
  },

  enter(params) {
    if (!live) window.addEventListener("keydown", onKey);
    live = true;
    closeOverlay();

    if (state.jobId == null || state.jobId === "") {
      bounce();
      return;
    }

    const rec = Q.jobById(state.jobId);
    if (!rec) {
      bounce();
      return;
    }

    const list = stepsOf(rec);
    if (!list.length) {
      bounce();
      return;
    }

    job = rec;
    steps = list;
    cropped = true;

    const raw = params && params.step;
    const wanted = Number(raw);
    index = Number.isFinite(wanted) ? Math.max(0, Math.min(list.length - 1, Math.trunc(wanted))) : 0;

    paintRelated();
    show();
  },

  leave() {
    live = false;
    closeOverlay();
    resetZoom();
    pointers.clear();
    window.removeEventListener("keydown", onKey);
  },
});
