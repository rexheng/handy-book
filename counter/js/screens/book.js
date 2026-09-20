import { state, set, go, emit, registerScreen } from "../bus.js";
import * as Q from "../query.js";

registerScreen("book", {
  mount(root) {
    build(root);
    const job = state.jobId ? Q.jobById(state.jobId) : null;
    if (job && job.pages && job.pages[0] != null) {
      preload(Q.pageUrl(job.manualId, job.pages[0]));
    }
  },
  enter() {
    if (!state.bikeId) {
      bounce("identify");
      return;
    }
    if (!state.jobId) {
      bounce("pick");
      return;
    }
    const job = Q.jobById(state.jobId);
    if (!job || job.bikeId !== state.bikeId || !job.pages || job.pages[0] == null) {
      bounce("pick");
      return;
    }
    paint(job);
    preload(Q.pageUrl(job.manualId, job.pages[0]));
  },
  leave() {
    teardown();
  },
});

let rootEl = null;
let coverEl = null;
let titleEl = null;
let stampEl = null;
let viewEl = null;
let stageEl = null;
let imgEl = null;
let canvasEl = null;
let stripEl = null;
let followEl = null;

let jobRec = null;
let manualRec = null;
let currentPage = null;
let fit = "width";
let drag = null;
let ro = null;
let gen = 0;
let fitLocked = false;

function bounce(id) {
  queueMicrotask(() => go(id));
}

function preload(url) {
  if (!url) return;
  const im = new Image();
  im.decoding = "async";
  im.src = url;
}

function el(tag, attrs) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
  }
  return node;
}

function build(root) {
  rootEl = root;
  root.replaceChildren();

  const head = el("header", { class: "sheet book-head" });
  coverEl = el("img", {
    class: "book-cover",
    width: "44",
    height: "62",
    alt: "",
    loading: "lazy",
    decoding: "async",
  });
  titleEl = el("p", { class: "book-title" });
  stampEl = el("span", { class: "stamp book-stamp" });
  head.append(coverEl, titleEl, stampEl);

  viewEl = el("div", {
    class: "page-view",
    tabindex: "0",
    role: "button",
    "aria-pressed": "false",
  });
  stageEl = el("div", { class: "page-stage" });
  imgEl = el("img", {
    class: "page-img",
    alt: "",
    loading: "lazy",
    decoding: "async",
  });
  canvasEl = el("canvas", { class: "page-canvas", hidden: true });
  stageEl.append(imgEl, canvasEl);
  viewEl.append(stageEl);

  stripEl = el("div", { class: "page-strip", role: "list" });

  followEl = el("button", {
    class: "btn btn-primary book-follow",
    type: "button",
    text: "Follow",
  });

  root.append(head, viewEl, stripEl, followEl);

  imgEl.addEventListener("load", onImgLoad);
  imgEl.addEventListener("error", onImgError);
  viewEl.addEventListener("pointerdown", onPtrDown);
  viewEl.addEventListener("pointermove", onPtrMove);
  viewEl.addEventListener("pointerup", onPtrUp);
  viewEl.addEventListener("pointercancel", () => {
    drag = null;
  });
  viewEl.addEventListener("click", onViewClick);
  viewEl.addEventListener("keydown", onViewKey);
  followEl.addEventListener("click", () => go("follow"));
  window.addEventListener("resize", applyZoom);

  ro = new ResizeObserver(() => applyZoom());
  ro.observe(viewEl);
}

function teardown() {
  fit = "width";
  drag = null;
  if (viewEl) {
    viewEl.setAttribute("aria-pressed", "false");
    viewEl.classList.remove("fit-h");
  }
}

function jobPagesOf(job) {
  const pages = [];
  const seen = new Set();
  for (const n of job.pages || []) {
    if (n == null || seen.has(n)) continue;
    seen.add(n);
    pages.push(n);
  }
  return pages;
}

function relatedPagesOf(job, used) {
  const pages = [];
  for (const row of job.related || []) {
    const n = row && row.page;
    if (n == null || used.has(n)) continue;
    used.add(n);
    pages.push(n);
  }
  return pages;
}

function tocPagesOf(manual) {
  const out = [];
  for (const row of (manual && manual.toc) || []) {
    const n = Number(row && row.page);
    if (!Number.isFinite(n)) continue;
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

function tocSpanContains(tocPages, n) {
  if (n == null) return { start: null, end: Infinity };
  let start = tocPages[0] ?? n;
  let end = Infinity;
  for (let i = 0; i < tocPages.length; i++) {
    if (tocPages[i] <= n) start = tocPages[i];
    if (tocPages[i] > n) {
      end = tocPages[i];
      break;
    }
  }
  return { start, end };
}

function isJobPage(pdfIndex) {
  if (pdfIndex == null || !jobRec || !jobRec.pages) return false;
  const n = Number(pdfIndex);
  return jobRec.pages.some((page) => Number(page) === n);
}

function printedLabel(pdfIndex) {
  if (pdfIndex == null || !jobRec) return null;
  const raw = jobRec.printedPage;
  const base = jobRec.pages && jobRec.pages[0];
  if (raw == null || String(raw).trim() === "" || base == null) return null;
  const printed = String(raw).trim();
  const pdf = Number(pdfIndex);
  const origin = Number(base);
  if (/^\d+$/.test(printed)) {
    return String(pdf - origin + Number(printed));
  }
  const sec = printed.match(/^(\d+)-(\d+)$/);
  if (sec) {
    const label = `${sec[1]}-${Number(sec[2]) + (pdf - origin)}`;
    if (isJobPage(pdf)) return label;
    const tocPages = tocPagesOf(manualRec);
    const here = tocSpanContains(tocPages, origin);
    if (pdf < here.start || pdf >= here.end) return null;
    return label;
  }
  if (pdf === origin) return printed;
  return null;
}

function stampText(n) {
  const label = printedLabel(n);
  return label ? `p.${label}` : "";
}

function writeStamp(node, n) {
  const text = stampText(n);
  node.textContent = text;
  node.hidden = !text;
  return text;
}

function guessRaster(manualId) {
  if (String(manualId || "").includes("suzuki")) return { w: 1400, h: 1991 };
  return { w: 1400, h: 994 };
}

function setAspectBox(w, h) {
  if (!w || !h) return;
  const ar = `${w} / ${h}`;
  if (rootEl) {
    rootEl.style.setProperty("--page-ar", ar);
    rootEl.style.setProperty("--thumb-ar", w >= h ? "300 / 213" : "300 / 427");
  }
}

function applyDefaultFit(w, h) {
  fit = w > h ? "height" : "width";
  if (!viewEl) return;
  viewEl.setAttribute("aria-pressed", fit === "height" ? "true" : "false");
  viewEl.classList.toggle("fit-h", fit === "height");
}

function paint(job) {
  jobRec = job;
  manualRec = Q.manual(job.manualId) || {};
  currentPage = job.pages[0];
  fitLocked = false;
  const guess = guessRaster(job.manualId);
  setAspectBox(guess.w, guess.h);
  applyDefaultFit(guess.w, guess.h);
  if (viewEl) {
    viewEl.scrollTop = 0;
    viewEl.scrollLeft = 0;
  }

  const title = manualRec.title || "";
  titleEl.textContent = title;

  coverEl.src = Q.thumbUrl(job.manualId, 1);
  coverEl.alt = title;

  paintStrip(job);
  showPage(currentPage, job.title);
}

function paintStrip(job) {
  stripEl.replaceChildren();
  const jobPages = jobPagesOf(job);
  const used = new Set(jobPages);
  const related = relatedPagesOf(job, used);
  const relatedTitle = new Map();
  for (const row of job.related || []) {
    if (row && row.page != null) relatedTitle.set(row.page, row.title || "");
  }

  jobPages.forEach((n) => stripEl.append(thumbBtn(n, false, false, job.title)));
  related.forEach((n, i) =>
    stripEl.append(thumbBtn(n, true, i === 0 && jobPages.length > 0, relatedTitle.get(n) || job.title)),
  );
}

function thumbBtn(n, related, gapStart, fallbackName) {
  const label = printedLabel(n);
  const btn = el("button", {
    class: "strip-item" + (related ? " related" : "") + (gapStart ? " related-start" : ""),
    type: "button",
    role: "listitem",
    "aria-label": label || fallbackName || undefined,
    "data-page": String(n),
  });
  const img = el("img", {
    alt: "",
    loading: "lazy",
    decoding: "async",
    width: "90",
    height: "64",
  });
  img.src = Q.thumbUrl(jobRec.manualId, n);
  img.addEventListener("load", () => {
    if (img.naturalWidth && img.naturalHeight) {
      btn.style.setProperty("--thumb-ar", `${img.naturalWidth} / ${img.naturalHeight}`);
    }
  });
  const stripLabel = el("span", { class: "strip-label", "aria-hidden": "true" });
  const stamp = el("span", { class: "stamp" });
  writeStamp(stamp, n);
  btn.append(img, stripLabel, stamp);
  btn.addEventListener("click", () => {
    showPage(n, jobRec.title);
  });
  return btn;
}

function markStrip() {
  stripEl.querySelectorAll(".strip-item").forEach((btn) => {
    const on = Number(btn.getAttribute("data-page")) === currentPage;
    btn.classList.toggle("now", on);
    if (on) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  });
}

function publishPage(n) {
  set({ page: n });
  emit("page", { n });
}

function showPage(n, alt) {
  currentPage = n;
  gen += 1;
  fitLocked = false;
  markStrip();
  writeStamp(stampEl, n);
  imgEl.alt = alt || "";
  canvasEl.hidden = true;
  canvasEl.removeAttribute("data-ready");
  imgEl.hidden = false;
  const guess = guessRaster(jobRec && jobRec.manualId);
  applyDefaultFit(guess.w, guess.h);
  if (viewEl) {
    viewEl.scrollTop = 0;
    viewEl.scrollLeft = 0;
  }
  const url = Q.pageUrl(jobRec.manualId, n);
  imgEl.src = url;
  publishPage(n);
  if (imgEl.complete) {
    if (imgEl.naturalWidth) onImgLoad();
    else onImgError();
  }
}

function onImgLoad() {
  canvasEl.hidden = true;
  imgEl.hidden = false;
  if (imgEl.naturalWidth && imgEl.naturalHeight) {
    setAspectBox(imgEl.naturalWidth, imgEl.naturalHeight);
    if (!fitLocked) applyDefaultFit(imgEl.naturalWidth, imgEl.naturalHeight);
  }
  applyZoom();
}

async function onImgError() {
  const n = pageFromSrc(imgEl.src) ?? currentPage;
  const file = manualRec && manualRec.file;
  if (!file || n == null) return;
  const token = gen;
  imgEl.hidden = true;
  canvasEl.hidden = false;
  canvasEl.removeAttribute("data-ready");
  try {
    const { renderPage } = await import("../pdf.js");
    if (token !== gen) return;
    await renderPage(Q.asset(file), n, canvasEl);
    if (token !== gen) return;
    canvasEl.setAttribute("data-ready", "1");
    if (canvasEl.width && canvasEl.height) {
      setAspectBox(canvasEl.width, canvasEl.height);
      if (!fitLocked) applyDefaultFit(canvasEl.width, canvasEl.height);
    }
    applyZoom();
  } catch {
    /* leave the empty canvas; no copy */
  }
}

function pageFromSrc(src) {
  const m = String(src || "").match(/p-(\d+)\.(?:webp|png|jpg|jpeg)(?:\?|$)/i);
  return m ? Number(m[1]) : null;
}

function mediaSize() {
  if (!imgEl.hidden && imgEl.naturalWidth) {
    return { w: imgEl.naturalWidth, h: imgEl.naturalHeight, node: imgEl };
  }
  if (!canvasEl.hidden && canvasEl.width) {
    return { w: canvasEl.width, h: canvasEl.height, node: canvasEl };
  }
  return null;
}

function scaleFor(media) {
  if (!viewEl || !media) return 0;
  const availW = viewEl.clientWidth;
  const availH = viewEl.clientHeight;
  if (!availW) return 0;
  if (fit === "height") {
    const h = availH > 0 ? availH : 160;
    return h / media.h;
  }
  return availW / media.w;
}

function applyZoom() {
  if (!viewEl || !stageEl) return;
  const media = mediaSize();
  if (!media) return;
  const scale = scaleFor(media);
  if (!scale) return;
  stageEl.style.width = `${media.w * scale}px`;
  stageEl.style.height = `${media.h * scale}px`;
  media.node.style.width = `${media.w}px`;
  media.node.style.height = `${media.h}px`;
  media.node.style.transform = `scale(${scale})`;
  const other = media.node === imgEl ? canvasEl : imgEl;
  other.style.transform = "";
}

function viewLocal(e) {
  const rect = viewEl.getBoundingClientRect();
  if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  return { x: rect.width / 2, y: rect.height / 2 };
}

function toggleFit(e) {
  fitLocked = true;
  const media = mediaSize();
  const prev = scaleFor(media);
  const local = viewLocal(e);
  const pageX = prev ? (viewEl.scrollLeft + local.x) / prev : 0;
  const pageY = prev ? (viewEl.scrollTop + local.y) / prev : 0;
  fit = fit === "width" ? "height" : "width";
  viewEl.setAttribute("aria-pressed", fit === "height" ? "true" : "false");
  viewEl.classList.toggle("fit-h", fit === "height");
  applyZoom();
  const next = scaleFor(mediaSize());
  if (next) {
    viewEl.scrollLeft = pageX * next - local.x;
    viewEl.scrollTop = pageY * next - local.y;
  }
}

function onPtrDown(e) {
  drag = { x: e.clientX, y: e.clientY, moved: false };
}

function onPtrMove(e) {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) drag.moved = true;
}

function onPtrUp() {
  /* click handler reads drag.moved */
}

function onViewClick(e) {
  if (e.target.closest("button")) return;
  if (drag && drag.moved) {
    drag = null;
    return;
  }
  drag = null;
  toggleFit(e);
}

function onViewKey(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  toggleFit();
}
