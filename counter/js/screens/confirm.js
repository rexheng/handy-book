import { state, set, go, registerScreen } from "../bus.js";
import * as Q from "../query.js";

const SVG = "http://www.w3.org/2000/svg";
const els = {};

function glyph(d) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "3");
  path.setAttribute("stroke-linecap", "square");
  path.setAttribute("stroke-linejoin", "miter");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function preload(src) {
  if (!src) return;
  const img = new Image();
  img.decoding = "async";
  img.src = src;
}

function bounce() {
  queueMicrotask(() => go("identify", { replace: true }));
}

registerScreen("confirm", {
  mount(root) {
    const photo = document.createElement("div");
    photo.className = "confirm-photo";

    const bikeImg = document.createElement("img");
    bikeImg.className = "confirm-bike";
    bikeImg.loading = "lazy";
    bikeImg.decoding = "async";
    bikeImg.alt = "";

    const shotImg = document.createElement("img");
    shotImg.className = "confirm-shot card";
    shotImg.loading = "lazy";
    shotImg.decoding = "async";
    shotImg.alt = "";
    shotImg.hidden = true;

    photo.append(bikeImg, shotImg);

    const sheet = document.createElement("div");
    sheet.className = "sheet confirm-id";

    const name = document.createElement("h1");
    name.className = "confirm-name";

    const stamps = document.createElement("div");
    stamps.className = "confirm-stamps";

    const yearStamp = document.createElement("span");
    yearStamp.className = "stamp";

    const ccStamp = document.createElement("span");
    ccStamp.className = "stamp";

    const catStamp = document.createElement("span");
    catStamp.className = "stamp";
    catStamp.hidden = true;

    stamps.append(yearStamp, ccStamp, catStamp);
    sheet.append(name, stamps);

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn btn-primary";
    yes.setAttribute("aria-label", "Yes");
    yes.append(glyph("M4 12.5 9.5 18 20 6"));
    yes.addEventListener("click", () => go("pick"));

    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn";
    no.setAttribute("aria-label", "No");
    no.append(glyph("M5 5l14 14M19 5L5 19"));
    no.addEventListener("click", () => {
      set({ bikeId: null, photoUrl: null });
      go("identify");
    });

    actions.append(yes, no);
    root.append(photo, sheet, actions);

    els.bikeImg = bikeImg;
    els.shotImg = shotImg;
    els.name = name;
    els.yearStamp = yearStamp;
    els.ccStamp = ccStamp;
    els.catStamp = catStamp;

    const rec = Q.bike(state.bikeId);
    if (rec?.image) preload(Q.asset(rec.image));
  },

  enter() {
    const id = state.bikeId;
    if (id == null || id === "") {
      bounce();
      return;
    }

    const rec = Q.bike(id);
    if (!rec) {
      bounce();
      return;
    }

    const label = [rec.make, rec.model].filter(Boolean).join(" ");
    const src = rec.image ? Q.asset(rec.image) : "";

    if (src) preload(src);

    els.name.textContent = label;

    if (rec.year == null || rec.year === "") {
      els.yearStamp.hidden = true;
      els.yearStamp.textContent = "";
    } else {
      els.yearStamp.hidden = false;
      els.yearStamp.textContent = String(rec.year);
    }

    if (rec.cc == null || rec.cc === "") {
      els.ccStamp.hidden = true;
      els.ccStamp.textContent = "";
    } else {
      els.ccStamp.hidden = false;
      els.ccStamp.textContent = `${rec.cc} cc`;
    }

    if (rec.category) {
      els.catStamp.hidden = false;
      els.catStamp.textContent = String(rec.category);
    } else {
      els.catStamp.hidden = true;
      els.catStamp.textContent = "";
    }

    els.bikeImg.alt = label;
    if (src) els.bikeImg.src = src;
    else els.bikeImg.removeAttribute("src");

    const shot = state.photoUrl;
    if (shot) {
      els.shotImg.alt = label;
      els.shotImg.src = Q.asset(shot);
      els.shotImg.hidden = false;
    } else {
      els.shotImg.hidden = true;
      els.shotImg.removeAttribute("src");
      els.shotImg.alt = "";
    }
  },

  leave() {},
});
