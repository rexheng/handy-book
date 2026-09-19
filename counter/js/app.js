import { go, state, on } from "./bus.js";
import { loadCatalog } from "./query.js";

const SCREENS = ["identify", "confirm", "pick", "book", "follow", "invoice"];

function paintTicket() {
  const el = document.querySelector("[data-ticket]");
  if (el) el.textContent = state.ticket;
}

async function boot() {
  try {
    await loadCatalog();
  } catch (err) {
    console.warn("catalog load failed", err);
  }

  for (const id of SCREENS) {
    try {
      await import(`./screens/${id}.js`);
    } catch (err) {
      console.warn(`screen module missing: ${id}`, err);
    }
  }

  paintTicket();
  on("state", (patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, "ticket")) paintTicket();
  });

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch (err) {
      console.warn("sw register failed", err);
    }
  }

  go(location.hash.slice(1) || "identify", { replace: true });
}

boot();
