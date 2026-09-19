import { state, set, go, emit, registerScreen } from "../bus.js";
import * as Q from "../query.js";

const TAX = 0.0825;
const CHANNELS = [
  ["quote", "Quote"],
  ["new", "New"],
  ["used", "Used"],
  ["other", "Other"],
];
const CHANNEL_IDS = CHANNELS.map(([id]) => id);

let root;
let els;
let seenJob = null;
let pickUsed = -1;
let pickAlt = -1;

function bounce() {
  queueMicrotask(() => go(state.bikeId ? "pick" : "identify", { replace: true }));
}

function h(tag, attrs) {
  const node = document.createElement(tag);
  if (!attrs) return node;
  for (const [key, val] of Object.entries(attrs)) {
    if (val == null || val === false) continue;
    if (key === "class") node.className = val;
    else if (key === "text") node.textContent = val;
    else if (key === "hidden") node.hidden = true;
    else node.setAttribute(key, val === true ? "" : String(val));
  }
  return node;
}

function money(n, dash) {
  if (dash) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "Free";
  return "$" + v.toFixed(2);
}

function totals(price, ship) {
  const pc = Math.round(Number(price) * 100);
  const sc = Math.round(Number(ship) * 100);
  const tc = Math.round((pc + sc) * TAX);
  return { price: pc / 100, ship: sc / 100, tax: tc / 100, total: (pc + sc + tc) / 100 };
}

function jobOf() {
  return state.jobId ? Q.jobById(state.jobId) : undefined;
}

function lineOf(job) {
  const ch = state.channel;
  if (ch === "used" && pickUsed >= 0) {
    const row = Array.isArray(job.used) ? job.used[pickUsed] : null;
    if (row) return { price: row.price, ship: 0, dash: false };
  }
  if (ch === "other" && pickAlt >= 0 && Array.isArray(job.alts) && job.alts[pickAlt] != null) {
    return { price: 0, ship: 0, dash: true };
  }
  return { price: job.price, ship: job.ship, dash: false };
}

function ticketLines(job, part, bike, dash, t) {
  const bikeLine = [bike.make, bike.model, bike.year].filter((x) => x != null && x !== "").join(" ");
  const partLine = [part.name, job.oem].filter((x) => x != null && x !== "").join("  ");
  return [
    String(state.ticket || ""),
    bikeLine,
    partLine,
    `Part  ${money(t.price, dash)}`,
    `Ship  ${money(t.ship, dash)}`,
    `Tax 8.25%  ${money(t.tax, dash)}`,
    `Total  ${money(t.total, dash)}`,
  ].filter(Boolean);
}

function mailtoHref(job, part, bike, dash, t) {
  const to = String(state.email || "").trim();
  const subject = `Handy Book ${state.ticket}`;
  const body = ticketLines(job, part, bike, dash, t).join("\n");
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function setChannel(ch) {
  if (state.channel === ch) return;
  set({ channel: ch });
  emit("channel", { ch });
  paint();
}

function listKey(rows) {
  return rows
    .map((row) => (typeof row === "string" ? row : [row.from, row.where, row.price].join("\0")))
    .join("\n");
}

function syncRowState(box, selected) {
  const kids = box.children;
  for (let i = 0; i < kids.length; i++) {
    const on = i === selected;
    kids[i].classList.toggle("selected", on);
    kids[i].classList.toggle("btn-primary", on);
    kids[i].setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function fillList(box, rows, selected, onPick) {
  const key = listKey(rows);
  if (box.dataset.rows === key && box.childElementCount === rows.length) {
    syncRowState(box, selected);
    return;
  }
  box.replaceChildren();
  box.dataset.rows = key;
  rows.forEach((row, i) => {
    const btn = h("button", { type: "button", class: "card inv-row" });
    if (typeof row === "string") {
      btn.append(h("span", { text: row }));
    } else {
      const a = h("span", { text: row.from || "" });
      const b = h("span", { text: row.where || "" });
      const c = h("span", { class: "inv-amt", text: money(row.price, false) });
      btn.append(a, b, c);
    }
    btn.addEventListener("click", () => onPick(i, btn));
    box.append(btn);
  });
  syncRowState(box, selected);
}

function clearList(box) {
  box.replaceChildren();
  delete box.dataset.rows;
}

function pickRow(kind, i, node) {
  if (kind === "used") pickUsed = i;
  else pickAlt = i;
  const box = kind === "used" ? els.used : els.alts;
  syncRowState(box, i);
  paintTicket();
  if (node && document.activeElement !== node) node.focus();
}

function paintTicket() {
  if (!els) return;
  const job = jobOf();
  if (!job) return;
  const part = Q.part(job.partId) || {};
  const bike = Q.bike(job.bikeId) || Q.bike(state.bikeId) || {};
  const line = lineOf(job);
  const t = line.dash ? { price: 0, ship: 0, tax: 0, total: 0 } : totals(line.price, line.ship);
  const dash = line.dash;
  els.tixNo.textContent = state.ticket || "";
  els.tixBike.textContent = [bike.make, bike.model, bike.year].filter((x) => x != null && x !== "").join(" ");
  els.tixPart.textContent = part.name || "";
  els.tixOem.textContent = job.oem || "";
  els.amtPart.textContent = money(t.price, dash);
  els.amtShip.textContent = money(t.ship, dash);
  els.amtTax.textContent = money(t.tax, dash);
  els.amtTotal.textContent = money(t.total, dash);
  syncMail(job, part, bike, dash, t);
}

function syncMail(job, part, bike, dash, t) {
  const href = mailtoHref(job, part, bike, dash, t);
  els.quoteSend.href = href;
  els.send.href = href;
}

function paint() {
  if (!els) return;
  const job = jobOf();
  if (!job) return;
  const part = Q.part(job.partId) || {};
  const bike = Q.bike(job.bikeId) || Q.bike(state.bikeId) || {};
  const ch = state.channel;
  const src = Q.asset(part.thumb || part.image);

  els.photo.alt = part.name || "";
  if (src) {
    els.photo.src = src;
    els.photo.hidden = false;
  } else {
    els.photo.removeAttribute("src");
    els.photo.hidden = true;
  }

  els.name.textContent = part.name || "";
  els.oem.textContent = job.oem || "";
  els.stamp.textContent = [bike.model, bike.year].filter((x) => x != null && x !== "").join(" · ");

  for (const btn of els.chBtns) {
    const on = btn.dataset.ch === ch;
    btn.classList.toggle("btn-primary", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  els.quote.hidden = ch !== "quote";
  els.fresh.hidden = ch !== "new";
  els.used.hidden = ch !== "used";
  els.alts.hidden = ch !== "other";

  if (document.activeElement !== els.email) els.email.value = state.email || "";

  els.from.textContent = job.from || "";
  els.days.textContent = `${Number(job.days) || 0} d`;
  els.price.textContent = money(job.price, false);

  const used = Array.isArray(job.used) ? job.used : [];
  const alts = Array.isArray(job.alts) ? job.alts : [];
  if (ch === "used") {
    fillList(els.used, used, pickUsed, (i, btn) => pickRow("used", i, btn));
  } else {
    clearList(els.used);
  }
  if (ch === "other") {
    fillList(els.alts, alts, pickAlt, (i, btn) => pickRow("other", i, btn));
  } else {
    clearList(els.alts);
  }

  paintTicket();
}

function drawTicket(ctx, w, h, job, part, bike, dash, t, img) {
  ctx.fillStyle = "#ece7dc";
  ctx.fillRect(0, 0, w, h);
  const x = 24;
  const y = 24;
  const tw = w - 48;
  const th = h - 48;
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, tw, th);
  ctx.strokeStyle = "#141414";
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + tw, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeRect(x, y + 1.5, tw, th - 1.5);

  ctx.fillStyle = "#e85d04";
  ctx.fillRect(x, y + 3, tw, 52);
  ctx.fillStyle = "#fff";
  ctx.font = "800 32px 'Big Shoulders Display', sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(String(state.ticket || ""), x + tw - 16, y + 29);

  const px = x + 16;
  const py = y + 70;
  ctx.fillStyle = "#141414";
  ctx.strokeRect(px, py, 88, 88);
  if (img && img.naturalWidth) {
    const dw = 82;
    const dh = 82;
    const ir = img.naturalWidth / img.naturalHeight;
    const r = dw / dh;
    let sx = 0;
    let sy = 0;
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    if (ir > r) {
      sw = img.naturalHeight * r;
      sx = (img.naturalWidth - sw) / 2;
    } else {
      sh = img.naturalWidth / r;
      sy = (img.naturalHeight - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, px + 3, py + 3, dw, dh);
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "800 22px Barlow, sans-serif";
  ctx.fillText([bike.make, bike.model, bike.year].filter(Boolean).join(" "), px + 104, py);
  ctx.font = "800 20px Barlow, sans-serif";
  ctx.fillText(part.name || "", px + 104, py + 28);
  ctx.font = "16px ui-monospace, monospace";
  ctx.fillText(job.oem || "", px + 104, py + 54);

  const rows = [
    ["Part", money(t.price, dash)],
    ["Ship", money(t.ship, dash)],
    ["Tax 8.25%", money(t.tax, dash)],
    ["Total", money(t.total, dash)],
  ];
  let ry = py + 112;
  rows.forEach((row, i) => {
    if (i === 3) {
      ctx.fillStyle = "#ffe600";
      ctx.fillRect(x + 8, ry - 8, tw - 16, 40);
      ctx.fillStyle = "#141414";
    }
    ctx.font = i === 3 ? "800 18px ui-monospace, monospace" : "16px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(row[0], px, ry);
    ctx.textAlign = "right";
    ctx.fillText(row[1], x + tw - 16, ry);
    ry += 36;
  });
}

async function savePng() {
  const job = jobOf();
  if (!job) return;
  const part = Q.part(job.partId) || {};
  const bike = Q.bike(job.bikeId) || {};
  const line = lineOf(job);
  const t = line.dash ? { price: 0, ship: 0, tax: 0, total: 0 } : totals(line.price, line.ship);
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* keep going */
    }
  }
  if (els.photo.src && typeof els.photo.decode === "function") {
    try {
      await els.photo.decode();
    } catch {
      /* draw without photo */
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = 780;
  canvas.height = 520;
  drawTicket(canvas.getContext("2d"), canvas.width, canvas.height, job, part, bike, line.dash, t, els.photo);
  await new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve();
        return;
      }
      const a = h("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `handy-book-${state.ticket}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resolve();
    }, "image/png");
  });
}

function mount(node) {
  root = node;
  root.replaceChildren();

  const head = h("div", { class: "sheet inv-head" });
  const frame = h("div", { class: "inv-photo" });
  const photo = h("img", { loading: "lazy", decoding: "async", alt: "" });
  frame.append(photo);
  const meta = h("div", { class: "inv-meta" });
  const name = h("div", { class: "inv-name" });
  const oem = h("div", { class: "inv-oem" });
  meta.append(name, oem);
  const stamp = h("span", { class: "stamp" });
  head.append(frame, meta, stamp);

  const ch = h("div", { class: "inv-ch" });
  const chBtns = CHANNELS.map(([id, label]) => {
    const btn = h("button", { type: "button", class: "btn", text: label, "data-ch": id, "aria-pressed": "false" });
    btn.addEventListener("click", () => setChannel(id));
    ch.append(btn);
    return btn;
  });

  const quote = h("div", { class: "inv-quote" });
  const email = h("input", {
    type: "email",
    placeholder: "you@shop.com",
    inputmode: "email",
    autocomplete: "email",
  });
  email.addEventListener("input", () => {
    set({ email: email.value });
    const job = jobOf();
    if (!job) return;
    const part = Q.part(job.partId) || {};
    const bike = Q.bike(job.bikeId) || {};
    const line = lineOf(job);
    const t = line.dash ? { price: 0, ship: 0, tax: 0, total: 0 } : totals(line.price, line.ship);
    syncMail(job, part, bike, line.dash, t);
  });
  const quoteSend = h("a", { class: "btn btn-primary", text: "Send", href: "mailto:" });
  quote.append(email, quoteSend);

  const fresh = h("div", { class: "card inv-new" });
  const from = h("span");
  const days = h("span", { class: "inv-amt" });
  const price = h("span", { class: "inv-amt" });
  fresh.append(from, days, price);

  const used = h("div", { class: "inv-list", "data-kind": "used" });
  const alts = h("div", { class: "inv-list", "data-kind": "alts" });

  const ticket = h("div", { class: "card inv-ticket" });
  const tixTop = h("div", { class: "inv-tix-top" });
  const tixBike = h("div", { class: "inv-tix-bike" });
  const tixNo = h("b", { class: "inv-tix-no" });
  tixTop.append(tixBike, tixNo);
  const tixPart = h("div", { class: "inv-tix-part" });
  const tixOem = h("div", { class: "inv-oem" });
  function row(label, amtRef) {
    const r = h("div", { class: "inv-tix-row" });
    r.append(h("span", { text: label }), amtRef);
    return r;
  }
  const amtPart = h("span", { class: "inv-amt" });
  const amtShip = h("span", { class: "inv-amt" });
  const amtTax = h("span", { class: "inv-amt" });
  const amtTotal = h("span", { class: "inv-amt" });
  const totalRow = row("Total", amtTotal);
  totalRow.classList.add("inv-due");
  ticket.append(tixTop, tixPart, tixOem, row("Part", amtPart), row("Ship", amtShip), row("Tax 8.25%", amtTax), totalRow);

  const foot = h("div", { class: "inv-foot" });
  const send = h("a", { class: "btn btn-primary", text: "Send", href: "mailto:" });
  const save = h("button", { type: "button", class: "btn", text: "Save" });
  save.addEventListener("click", () => {
    savePng().catch(() => {});
  });
  foot.append(send, save);

  const wrap = h("div", { class: "inv" });
  wrap.append(head, ch, quote, fresh, used, alts, ticket, foot);
  root.append(wrap);

  els = {
    photo,
    name,
    oem,
    stamp,
    chBtns,
    quote,
    email,
    quoteSend,
    fresh,
    from,
    days,
    price,
    used,
    alts,
    tixNo,
    tixBike,
    tixPart,
    tixOem,
    amtPart,
    amtShip,
    amtTax,
    amtTotal,
    send,
    save,
  };
}

function enter() {
  const job = jobOf();
  if (!job) {
    bounce();
    return;
  }
  if (seenJob !== job.id) {
    seenJob = job.id;
    pickUsed = -1;
    pickAlt = -1;
  }
  if (!CHANNEL_IDS.includes(state.channel)) {
    set({ channel: "new" });
    emit("channel", { ch: "new" });
  }
  paint();
}

registerScreen("invoice", {
  mount,
  enter,
  leave() {},
});
