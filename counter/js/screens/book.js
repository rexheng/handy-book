import { state, set, go, registerScreen } from "../bus.js";
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

function stampText(n) {
  return `p.${n}`;
}

function paint(job) {
  jobRec = job;
  manualRec = Q.manual(job.manualId) || {};
  currentPage = job.pages[0];
  fit = "width";
  if (viewEl) {
    viewEl.setAttribute("aria-pressed", "false");
    viewEl.classList.remove("fit-h");
  }

  const title = manualRec.title || "";
  titleEl.textContent = title;

  coverEl.src = Q.thumbUrl(job.manualId, 1);
  coverEl.alt = title;

  const printed = job.printedPage || job.pages[0];
  stampEl.textContent = stampText(printed);

  paintStrip(job);
  showPage(currentPage, job.title);
  set({ page: currentPage });
}

function paintStrip(job) {
  stripEl.replaceChildren();
  const jobPages = jobPagesOf(job);
  const used = new Set(jobPages);
  const related = relatedPagesOf(job, used);

  jobPages.forEach((n) => stripEl.append(thumbBtn(n, false, false)));
  related.forEach((n, i) => stripEl.append(thumbBtn(n, true, i === 0 && jobPages.length > 0)));
}

function thumbBtn(n, related, gapStart) {
  const btn = el("button", {
    class: "strip-item" + (related ? " related" : "") + (gapStart ? " related-start" : ""),
    type: "button",
    role: "listitem",
    "aria-label": String(n),
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
  const label = el("span", { class: "strip-label", "aria-hidden": "true" });
  const stamp = el("span", { class: "stamp", text: stampText(n) });
  btn.append(img, label, stamp);
  btn.addEventListener("click", () => {
    showPage(n, jobRec.title);
    set({ page: n });
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

function showPage(n, alt) {
  currentPage = n;
  gen += 1;
  markStrip();
  imgEl.alt = alt || "";
  canvasEl.hidden = true;
  canvasEl.removeAttribute("data-ready");
  imgEl.hidden = false;
  const url = Q.pageUrl(jobRec.manualId, n);
  imgEl.src = url;
  if (imgEl.complete) {
    if (imgEl.naturalWidth) onImgLoad();
    else onImgError();
  }
}

function onImgLoad() {
  canvasEl.hidden = true;
  imgEl.hidden = false;
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
    const boxW = Math.max(viewEl.clientWidth || 0, 360);
    const scale = (boxW * (window.devicePixelRatio || 1)) / 419;
    await renderPage(Q.asset(file), n, canvasEl, Math.max(scale, 1.5));
    if (token !== gen) return;
    canvasEl.setAttribute("data-ready", "1");
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

function applyZoom() {
  if (!viewEl || !stageEl) return;
  const media = mediaSize();
  if (!media) return;
  const availW = viewEl.clientWidth;
  const availH = viewEl.clientHeight;
  if (!availW) return;
  if (fit === "height" && !availH) return;
  const scale = fit === "height" ? availH / media.h : availW / media.w;
  stageEl.style.width = `${media.w * scale}px`;
  stageEl.style.height = `${media.h * scale}px`;
  media.node.style.width = `${media.w}px`;
  media.node.style.height = `${media.h}px`;
  media.node.style.transform = `scale(${scale})`;
  const other = media.node === imgEl ? canvasEl : imgEl;
  other.style.transform = "";
}

function toggleFit() {
  fit = fit === "width" ? "height" : "width";
  viewEl.setAttribute("aria-pressed", fit === "height" ? "true" : "false");
  viewEl.classList.toggle("fit-h", fit === "height");
  viewEl.scrollTop = 0;
  viewEl.scrollLeft = 0;
  applyZoom();
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
  toggleFit();
}

function onViewKey(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  toggleFit();
}
