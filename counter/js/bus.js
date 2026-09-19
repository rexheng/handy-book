const listeners = Object.create(null);
const screens = new Map();
let currentId = null;

export const state = {
  bikeId: null,
  photoUrl: null,
  systemId: null,
  partId: null,
  jobId: null,
  page: null,
  channel: null,
  email: "",
  ticket: "A-17",
};

export const FLOW = ["identify", "confirm", "pick", "book", "follow", "invoice"];

export function on(event, handler) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(handler);
}

export function emit(event, payload) {
  const list = listeners[event];
  if (!list) return;
  for (const handler of list.slice()) handler(payload);
}

export function set(patch) {
  if (!patch || typeof patch !== "object") return;
  Object.assign(state, patch);
  emit("state", patch);
}

export function registerScreen(id, api) {
  screens.set(id, {
    mount: api && api.mount,
    enter: api && api.enter,
    leave: api && api.leave,
    mounted: false,
  });
}

function allowed(id) {
  if (!FLOW.includes(id)) return false;
  if (id === "identify") return true;
  return state.bikeId != null && state.bikeId !== "";
}

function showSection(id) {
  document.querySelectorAll("section[data-screen]").forEach((section) => {
    section.hidden = section.getAttribute("data-screen") !== id;
  });
}

function updateRail(id) {
  const here = FLOW.indexOf(id);
  document.querySelectorAll("li[data-step]").forEach((li) => {
    const i = FLOW.indexOf(li.getAttribute("data-step"));
    if (i < 0) return;
    const now = i === here;
    li.classList.toggle("now", now);
    li.classList.toggle("done", i < here);
    if (now) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
}

function rootFor(id) {
  const section = document.querySelector(`section[data-screen="${id}"]`);
  if (!section) return null;
  return section.querySelector("[data-root], .root") || section;
}

export function go(id, params) {
  if (!FLOW.includes(id)) return;

  showSection(id);
  updateRail(id);

  if (currentId && currentId !== id) {
    const prev = screens.get(currentId);
    if (prev && typeof prev.leave === "function") prev.leave();
  }

  const rec = screens.get(id);
  if (rec) {
    if (!rec.mounted) {
      if (typeof rec.mount === "function") rec.mount(rootFor(id));
      rec.mounted = true;
    }
    if (typeof rec.enter === "function") rec.enter(params);
  }

  currentId = id;

  const hist = { screen: id };
  const url = "#" + id;
  if (params && params.replace) history.replaceState(hist, "", url);
  else history.pushState(hist, "", url);

  emit("screen", { id });
}

const initialHash =
  typeof location !== "undefined" ? location.hash.replace(/^#/, "") : "";

function bootFromHash() {
  if (!initialHash) return;
  go(allowed(initialHash) ? initialHash : "identify", { replace: true });
}

function onPop(event) {
  const hash = location.hash.replace(/^#/, "");
  const fromState = event.state && event.state.screen;
  const id = hash || fromState || "identify";
  go(FLOW.includes(id) ? id : "identify", { replace: true });
}

if (typeof window !== "undefined") {
  window.HandyBus = { state, go };
  window.addEventListener("popstate", onPop);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => queueMicrotask(bootFromHash), {
      once: true,
    });
  } else {
    queueMicrotask(bootFromHash);
  }
}
