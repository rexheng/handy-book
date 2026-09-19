import { state, set, go, emit, registerScreen } from "../bus.js";
import * as Q from "../query.js";
import * as vision from "../vision.js";

const DEBOUNCE_MS = 80;
const MATCH_FLOOR = 0.5;
const CAMERA_PATH =
  "M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9zm3 13.2a3.7 3.7 0 1 1 0-7.4 3.7 3.7 0 0 1 0 7.4z";

let root;
let searchEl;
let shotEl;
let queryEl;
let fileEl;
let progressEl;
let gridEl;
let debounceId = 0;
let visionGen = 0;
let lastBlob = null;

function el(tag, attrs) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  return node;
}

function cameraGlyph() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", CAMERA_PATH);
  svg.append(path);
  return svg;
}

function bikesFor(text) {
  const list = Q.findBikes(text).slice();
  const id = state.bikeId;
  if (!id) return list;
  const i = list.findIndex((bike) => bike.id === id);
  if (i > 0) {
    const [hit] = list.splice(i, 1);
    list.unshift(hit);
  }
  return list;
}

function choose(bikeId) {
  set({ bikeId });
  emit("bike", { bikeId });
  go("confirm");
}

function matchId(match) {
  if (!match || typeof match !== "object") return null;
  const score = Number(match.score);
  if (!(score >= MATCH_FLOOR)) return null;
  const bikeId = match.bikeId || match.id || match.bike?.id;
  return bikeId || null;
}

function showProgress(on) {
  progressEl.hidden = !on;
}

function showShot(url) {
  if (url) {
    shotEl.src = url;
    shotEl.hidden = false;
  } else {
    shotEl.removeAttribute("src");
    shotEl.hidden = true;
  }
}

function tileFor(bike) {
  const btn = el("button", { type: "button", className: "tile" });
  const img = el("img", {
    loading: "lazy",
    decoding: "async",
    alt: `${bike.make} ${bike.model}`,
  });
  img.src = Q.asset(bike.thumb || bike.image);
  const stamp = el("span", { className: "stamp", text: String(bike.year) });
  const name = el("span", {
    className: "id-name",
    text: `${bike.make} ${bike.model}`,
  });
  btn.append(img, stamp, name);
  btn.addEventListener("click", () => choose(bike.id));
  return btn;
}

function paintGrid() {
  const bikes = bikesFor(queryEl.value);
  const frag = document.createDocumentFragment();
  for (const bike of bikes) frag.append(tileFor(bike));
  gridEl.replaceChildren(frag);
}

function schedulePaint() {
  clearTimeout(debounceId);
  debounceId = setTimeout(paintGrid, DEBOUNCE_MS);
}

function onEnter(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const first = bikesFor(queryEl.value)[0];
  if (first) choose(first.id);
}

async function onFile() {
  const file = fileEl.files && fileEl.files[0];
  fileEl.value = "";
  if (!file) return;

  const gen = ++visionGen;
  if (lastBlob) URL.revokeObjectURL(lastBlob);
  const url = URL.createObjectURL(file);
  lastBlob = url;
  set({ photoUrl: url });
  showProgress(true);

  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (gen !== visionGen) return;

    let match = null;
    if (typeof vision.identifyBike === "function") {
      const roster = Q.catalog()?.bikes ?? [];
      match = await vision.identifyBike(img, roster);
    }
    if (gen !== visionGen) return;

    const bikeId = matchId(match);
    if (bikeId) {
      showShot(null);
      choose(bikeId);
      return;
    }

    showShot(url);
    queryEl.focus();
  } catch {
    if (gen !== visionGen) return;
    showShot(url);
    queryEl.focus();
  } finally {
    if (gen === visionGen) showProgress(false);
  }
}

registerScreen("identify", {
  mount(mountRoot) {
    root = mountRoot;
    searchEl = el("div", { className: "id-search" });
    shotEl = el("img", {
      className: "id-shot",
      loading: "lazy",
      decoding: "async",
      alt: "",
      hidden: true,
    });
    queryEl = el("input", {
      className: "id-q",
      type: "search",
      autocomplete: "off",
      enterkeyhint: "go",
      placeholder: "Honda CB650R",
    });
    const cam = el("button", {
      type: "button",
      className: "btn btn-icon",
      "aria-label": "Photo",
    });
    cam.append(cameraGlyph());
    fileEl = el("input", {
      className: "id-file",
      type: "file",
      accept: "image/*",
      capture: "environment",
      hidden: true,
      tabindex: "-1",
    });
    searchEl.append(shotEl, queryEl, cam, fileEl);

    progressEl = el("div", { className: "id-progress", hidden: true });
    const dock = el("div", { className: "id-dock" });
    dock.append(searchEl, progressEl);

    gridEl = el("div", { className: "id-grid" });
    root.replaceChildren(dock, gridEl);

    queryEl.addEventListener("input", schedulePaint);
    queryEl.addEventListener("keydown", onEnter);
    cam.addEventListener("click", () => fileEl.click());
    fileEl.addEventListener("change", onFile);
  },
  enter() {
    set({ partId: null, jobId: null, systemId: null });
    showShot(state.photoUrl);
    paintGrid();
  },
  leave() {
    clearTimeout(debounceId);
  },
});
