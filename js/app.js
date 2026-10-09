import { buildPlaceNavigationLinks } from "./services/map-navigation.js";
import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";


/* =========================================================
   FIREBASE
========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyCoHYgOL4hAs4ECxz8iMrc8d9458dOth3Q",
  authDomain: "seol-8eb80.firebaseapp.com",
  projectId: "seol-8eb80",
  storageBucket: "seol-8eb80.firebasestorage.app",
  messagingSenderId: "545533388832",
  appId: "1:545533388832:web:441dad1a09916bb14eb445",
  measurementId: "G-MZQ5L465GV"
};
const app = initializeApp(firebaseConfig);

const auth = getAuth(app);

const provider = new GoogleAuthProvider();

const db = getFirestore(app);


/* =========================================================
   CONSTANTS
========================================================= */

const TRIP_ID = "seoul-2026";

/** Trip date range (labels only; data always from Firestore) */
const TRIP_START = "2026-10-18";
const TRIP_END = "2026-10-25";
const TRIP_TIMEZONE = "Asia/Seoul";

const tripRef = collection(db, "trips", TRIP_ID, "activities");
const placesRef = collection(db, "trips", TRIP_ID, "places");
const expensesRef = collection(db, "trips", TRIP_ID, "expenses");
const dspRef = collection(db, "trips", TRIP_ID, "dsp");
const notesRef = collection(db, "trips", TRIP_ID, "notes");
const bookingsRef = collection(db, "trips", TRIP_ID, "bookings");
const checklistRef = collection(db, "trips", TRIP_ID, "checklist");


/* =========================================================
   STATE
========================================================= */

const state = {
  user: null,
  tab: "dashboard",
  selectedDay: TRIP_START,
  activities: [],
  places: [],
  expenses: [],
  dsp: [],
  dspMain: null,
  bookings: [],
  checklist: [],
  dayNoteText: "",
  alertedIds: {},
  unsubscribe: [],
  /** Tick for "now" UI — updated every 30s when on dashboard */
  nowTick: Date.now()
};

let dayMap = null;
let dayMapLayerGroup = null;
let nowTimer = null;


/* =========================================================
   HELPERS
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));
}


// Chỉ cho phép các thẻ định dạng nội dung mô tả; loại bỏ script/event handler.
function sanitizePlaceDescription(value) {
  const input = String(value ?? "").trim();
  if (!input) return "";

  const parser = new DOMParser();
  const parsed = parser.parseFromString(input, "text/html");
  const allowedTags = new Set([
    "P", "BR", "STRONG", "B", "EM", "I", "U", "S",
    "H2", "H3", "H4", "UL", "OL", "LI", "BLOCKQUOTE",
    "A", "IMG", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
    "HR", "CODE", "PRE"
  ]);

  function cleanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();

    const tag = node.tagName.toUpperCase();
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "SVG", "MATH"].includes(tag)) {
      return document.createDocumentFragment();
    }

    const children = document.createDocumentFragment();
    for (const child of Array.from(node.childNodes)) children.appendChild(cleanNode(child));
    if (!allowedTags.has(tag)) return children;

    const safe = document.createElement(tag.toLowerCase());
    if (tag === "A") {
      const href = node.getAttribute("href") || "";
      if (/^(https?:|mailto:|tel:)/i.test(href.trim())) {
        safe.setAttribute("href", href.trim());
        safe.setAttribute("target", "_blank");
        safe.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (tag === "IMG") {
      const src = node.getAttribute("src") || "";
      if (/^https?:\/\//i.test(src.trim())) {
        safe.setAttribute("src", src.trim());
        safe.setAttribute("alt", (node.getAttribute("alt") || "").slice(0, 200));
        safe.setAttribute("loading", "lazy");
        safe.setAttribute("referrerpolicy", "no-referrer");
      } else {
        return document.createDocumentFragment();
      }
    }
    if (tag === "TH" || tag === "TD") {
      for (const attr of ["colspan", "rowspan"]) {
        const v = Number(node.getAttribute(attr));
        if (Number.isInteger(v) && v >= 1 && v <= 20) safe.setAttribute(attr, String(v));
      }
    }
    safe.appendChild(children);
    return safe;
  }

  const output = document.createElement("div");
  for (const child of Array.from(parsed.body.childNodes)) output.appendChild(cleanNode(child));
  return output.innerHTML;
}


function money(value) {
  return new Intl.NumberFormat("ko-KR")
    .format(Number(value) || 0) + " ₩";
}


function minutes(time) {
  if (!time) return 0;
  const parts = String(time).split(":");
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  return h * 60 + m;
}


function formatDay(date) {
  return new Intl.DateTimeFormat("vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit"
  }).format(new Date(date + "T12:00:00"));
}


function formatDayLong(date) {
  return new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(date + "T12:00:00"));
}


function placeName(id) {
  const place = state.places.find(p => p.id === id);
  return place?.name || id || "—";
}


/**
 * Place detail: info từ Firestore + personalNote editable.
 * Không hard-code nội dung guide.
 */
function openPlaceDetail(placeId) {
  if (!placeId) {
    showToast("Không có địa điểm");
    return;
  }
  const place = state.places.find(p => p.id === placeId);
  if (!place) {
    showToast("Không tìm thấy địa điểm");
    return;
  }

  const lat = Number(place.lat);
  const lng = Number(place.lng);
  const hasCoord = Number.isFinite(lat) && Number.isFinite(lng);

  // Guide fields — chỉ hiện nếu có data trong Firestore
  const infoRows = [];
  const pushInfo = (label, value) => {
    const v = value == null ? "" : String(value).trim();
    if (!v) return;
    infoRows.push(`<div class="pd-section"><div class="pd-label">${escapeHtml(label)}</div><div class="pd-body">${escapeHtml(v)}</div></div>`);
  };
  const pushHtmlInfo = (label, value) => {
    const safeHtml = sanitizePlaceDescription(value);
    if (!safeHtml) return;
    infoRows.push(`<div class="pd-section"><div class="pd-label">${escapeHtml(label)}</div><div class="pd-body pd-rich-content">${safeHtml}</div></div>`);
  };

  pushInfo("Địa chỉ", place.address || place.addr);
  pushInfo("Khu vực", place.area || place.district || place.neighborhood);
  pushInfo("Loại", place.category || place.type || place.kind);
  pushInfo("Giờ mở", place.openHours || place.hours || place.openingHours);
  if (place.suggestedMinutes != null && place.suggestedMinutes !== "") {
    pushInfo("Thời gian gợi ý", String(place.suggestedMinutes) + " phút");
  }
  pushInfo("Giá / vé", place.priceNote || place.price || place.ticket);
  pushHtmlInfo("Mô tả", place.description || place.guide || place.summary);
  pushInfo("Tips", place.tips || place.tip || place.hints);
  // notes cũ trên place: coi là guide phụ nếu khác personalNote
  if (place.notes && String(place.notes).trim() &&
      String(place.notes).trim() !== String(place.personalNote || "").trim()) {
    pushInfo("Ghi chú sẵn", place.notes);
  }

  let dspHtml = "";
  if (place.dspAttractionId) {
    const attr = (state.dsp || []).find(d => d.id === place.dspAttractionId);
    const label = attr ? (attr.name || place.dspAttractionId) : place.dspAttractionId;
    const visited = attr && attr.visited ? " · đã dùng" : "";
    dspHtml = `<div class="pd-section"><div class="pd-label">DSP</div><div class="pd-body"><span class="pill blue">DSP</span> ${escapeHtml(label)}${escapeHtml(visited)}</div></div>`;
  }

  // Activities gắn place (sắp tới / gần đây)
  const related = (typeof activeActivities === "function" ? activeActivities() : state.activities)
    .filter(a => a.placeId === placeId)
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) ||
      String(a.startTime || "").localeCompare(String(b.startTime || "")));
  let relatedHtml = "";
  if (related.length) {
    relatedHtml = `<div class="pd-section"><div class="pd-label">Trong lịch trình</div>` +
      related.slice(0, 8).map(a => {
        const st = String(a.status || "").toLowerCase();
        const mark = st === "done" ? "✓" : st === "skipped" ? "–" : "○";
        return `<div class="small" style="padding:4px 0">${mark} <b>${escapeHtml(a.date || "")}</b> ${escapeHtml(a.startTime || "")}–${escapeHtml(a.endTime || "")} · ${escapeHtml(a.title || "—")}</div>`;
      }).join("") + `</div>`;
  }

  const personal = place.personalNote != null ? String(place.personalNote) : "";

  openModal(place.name || "Địa điểm", `
    <div class="place-detail">
      <div class="pd-section">
        <div class="pd-label">Tọa độ</div>
        <div class="pd-body small muted">
          ${hasCoord ? escapeHtml(lat + ", " + lng) : "Chưa có tọa độ"}
        </div>
        <div class="actions" style="margin-top:10px">
          <button type="button" class="btn primary" id="pdOpenMap">🗺 Mở Map (app)</button>
          <button type="button" class="btn" id="pdOpenMapChooser">…</button>
        </div>
      </div>

      ${infoRows.join("") || `<div class="pd-section"><div class="small muted">Chưa có mô tả / tips trên Firestore. Có thể bổ sung field description, tips, openHours… trên place.</div></div>`}
      ${dspHtml}
      ${relatedHtml}

      <div class="pd-section">
        <div class="pd-label">Note của bạn</div>
        <p class="small muted" style="margin:0 0 6px">Riêng cho địa điểm này · hai người thấy realtime</p>
        <textarea id="pdPersonalNote" placeholder="Xếp hàng, wifi, món nên order, tip cá nhân…">${escapeHtml(personal)}</textarea>
        <button type="button" class="btn primary" id="pdSaveNote" style="width:100%;margin-top:8px;min-height:44px">Lưu note</button>
      </div>
    </div>
  `);

  document.getElementById("pdOpenMap").onclick = () => openPlaceMaps(placeId);
  document.getElementById("pdOpenMapChooser").onclick = () => openPlaceMaps(placeId, { chooser: true });
  document.getElementById("pdSaveNote").onclick = async () => {
    const text = (document.getElementById("pdPersonalNote") || {}).value || "";
    try {
      await updateDoc(doc(db, "trips", TRIP_ID, "places", placeId), {
        personalNote: text,
        ...audit()
      });
      // cập nhật local ngay (onSnapshot cũng sẽ sync)
      const p = state.places.find(x => x.id === placeId);
      if (p) p.personalNote = text;
      showToast("Đã lưu note địa điểm");
    } catch (err) {
      alert(err.message);
    }
  };
}
window.openPlaceDetail = openPlaceDetail;




function showToast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    element.classList.add("hidden");
  }, 2200);
}


function renderConnectionState() {
  const online = navigator.onLine;
  document.body.classList.toggle("offline-mode", !online);
  document.querySelectorAll("[data-connection-state]").forEach(el => {
    el.textContent = online ? "Online" : "Offline";
    el.classList.toggle("red", !online);
    el.classList.toggle("green", online);
  });
}
window.addEventListener("online", renderConnectionState);
window.addEventListener("offline", renderConnectionState);


function audit() {
  return {
    updatedAt: new Date().toISOString(),
    updatedBy: {
      uid: state.user?.uid || "",
      name: state.user?.displayName || "",
      email: state.user?.email || ""
    }
  };
}


/**
 * Trip clock is always Asia/Seoul. It does not depend on the phone/PC timezone.
 */
const tripClockFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRIP_TIMEZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
});
function tripClockParts(d = new Date()) {
  const parts = Object.fromEntries(tripClockFormatter.formatToParts(d).map(p => [p.type, p.value]));
  return parts;
}
function localDateString(d = new Date()) {
  const p = tripClockParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
function localTimeMinutes(d = new Date()) {
  const p = tripClockParts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}


function formatCountdown(ms) {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const days = Math.floor(h / 24);
    const rh = h % 24;
    return `${days}d ${rh}h`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}


/**
 * Haversine distance in km (as-the-crow-flies).
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}


function haversineM(lat1, lng1, lat2, lng2) {
  return haversineKm(lat1, lng1, lat2, lng2) * 1000;
}


/**
 * Classify activities for a day relative to "now".
 * Uses status field if present (done/skipped), else time windows.
 */

/** Activities not soft-deleted */
function activeExpenses() {
  return state.expenses.filter(e => {
    const st = String(e.status || "").toLowerCase();
    return st !== "deleted" && !e.deletedAt;
  });
}
function activeActivities() {
  return state.activities.filter(a => {
    const st = String(a.status || "").toLowerCase();
    return st !== "deleted" && !a.deletedAt;
  });
}
function isDeletedActivity(a) {
  const st = String(a.status || "").toLowerCase();
  return st === "deleted" || !!a.deletedAt;
}
function openPlaceMaps(placeId, options = {}) {
  if (!placeId) { showToast("Activity chưa gắn địa điểm"); return; }
  const place = state.places.find(p => p.id === placeId);
  if (!place) { showToast("Không tìm thấy địa điểm"); return; }
  const links = buildPlaceNavigationLinks(place);
  const forceChooser = !!options.chooser;
  if (!forceChooser && links.preferredApp) {
    try { window.location.href = links.preferredApp; return; } catch (_) {}
  }
  openModal("🗺 " + (place.name || "Bản đồ"), `
    <p style="margin:0 0 10px;font-weight:700">${escapeHtml(place.name || "—")}</p>
    ${links.hasCoord ? `<p class="small muted" style="margin:0 0 12px">${links.lat}, ${links.lng}</p>` : ""}
    <div class="actions route-choice-actions">
      ${links.naverApp ? `<button type="button" class="btn primary" id="openNaverApp">Naver Map</button>` : ""}
      ${links.googleApp ? `<button type="button" class="btn" id="openGoogleApp">Google Maps</button>` : ""}
      ${links.naverWeb ? `<button type="button" class="btn" id="openNaverWeb">Naver web</button>` : ""}
      ${links.googleWeb ? `<button type="button" class="btn" id="openGoogleWeb">Google web</button>` : ""}
      <button type="button" class="btn" id="copyPlaceName">📋 Sao chép</button>
    </div>
  `);
  const open = url => { if (!url) return; window.open(url, "_blank", "noopener,noreferrer"); };
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bind("openNaverApp", () => { closeModal(); window.location.href = links.naverApp; });
  bind("openGoogleApp", () => { closeModal(); window.location.href = links.googleApp; });
  bind("openNaverWeb", () => { closeModal(); open(links.naverWeb); });
  bind("openGoogleWeb", () => { closeModal(); open(links.googleWeb); });
  bind("copyPlaceName", async () => {
    const text = links.hasCoord ? `${place.name || ""} (${links.lat}, ${links.lng})` : (place.name || "");
    try { await navigator.clipboard.writeText(text); showToast("Đã sao chép"); }
    catch (_) { prompt("Sao chép:", text); }
  });
}
window.openPlaceMaps = openPlaceMaps;
window.openPlaceMaps = openPlaceMaps;



function tripDays() {
  const days = [];
  const start = new Date(TRIP_START + "T12:00:00");
  const end = new Date(TRIP_END + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    days.push(`${y}-${m}-${day}`);
  }
  // also include any activity dates outside range
  for (const a of state.activities) {
    if (a.date && !days.includes(a.date)) days.push(a.date);
  }
  return days.sort();
}

function classifyDayActivities(day, now = new Date()) {
  const dayStr = day;
  const todayStr = localDateString(now);
  const nowMin = localTimeMinutes(now);

  const list = activeActivities()
    .filter(a => a.date === dayStr)
    .slice()
    .sort((a, b) => {
      const orderA = a.order != null ? Number(a.order) : Infinity;
      const orderB = b.order != null ? Number(b.order) : Infinity;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    });

  return list.map(a => {
    const status = String(a.status || "").toLowerCase();
    if (status === "done" || status === "completed") {
      return { activity: a, state: "done" };
    }
    if (status === "skipped") {
      return { activity: a, state: "skipped" };
    }

    // Only use clock for the actual calendar day
    if (dayStr !== todayStr) {
      if (dayStr < todayStr) return { activity: a, state: "done" };
      return { activity: a, state: "upcoming" };
    }

    const start = minutes(a.startTime);
    const end = minutes(a.endTime) || start + 60;

    if (nowMin >= end) return { activity: a, state: "done" };
    if (nowMin >= start && nowMin < end) return { activity: a, state: "current" };
    return { activity: a, state: "upcoming" };
  });
}


function getDayMapPoints(day) {
  const dayActivities = activeActivities()
    .filter(a => a.date === day)
    .slice()
    .sort((a, b) => {
      const orderA = a.order != null ? Number(a.order) : Infinity;
      const orderB = b.order != null ? Number(b.order) : Infinity;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    });

  const points = [];

  for (const activity of dayActivities) {
    if (!activity.placeId) continue;
    const place = state.places.find(p => p.id === activity.placeId);
    if (!place) continue;
    const lat = Number(place.lat);
    const lng = Number(place.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push({ activity, place, lat, lng });
  }

  return points;
}


/* =========================================================
   MODAL
========================================================= */

function openModal(title, html) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modal").classList.remove("hidden");
}


function closeModal() {
  document.getElementById("modal").classList.add("hidden");
}


document.getElementById("modalClose").onclick = closeModal;

document.getElementById("modal").onclick = event => {
  if (event.target.id === "modal") closeModal();
};


/* =========================================================
   NAVIGATION
========================================================= */

document.querySelectorAll("#nav button").forEach(button => {
  button.onclick = () => {
    state.tab = button.dataset.tab;

    document.querySelectorAll("#nav button").forEach(btn => {
      btn.classList.toggle("active", btn === button);
    });

    ["dashboard", "itinerary", "dsp", "expenses", "places", "more"].forEach(tab => {
      document.getElementById("tab-" + tab).classList.toggle("hidden", tab !== state.tab);
    });

    render();
  };
});



/* Bottom nav sync */
document.querySelectorAll("#navBottom button").forEach(button => {
  button.onclick = () => {
    state.tab = button.dataset.tab;
    document.querySelectorAll("#nav button, #navBottom button").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === state.tab);
    });
    ["dashboard","itinerary","dsp","expenses","places","more"].forEach(tab => {
      document.getElementById("tab-" + tab).classList.toggle("hidden", tab !== state.tab);
    });
    render();
  };
});

/* =========================================================
   FIRESTORE REALTIME
========================================================= */

function subscribeFirestore() {
  state.unsubscribe.forEach(unsub => unsub?.());
  state.unsubscribe = [];

  state.unsubscribe.push(
    onSnapshot(tripRef, snapshot => {
      state.activities = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) =>
          (String(a.date) + String(a.startTime)).localeCompare(
            String(b.date) + String(b.startTime)
          )
        );
      render();
    })
  );

  state.unsubscribe.push(
    onSnapshot(placesRef, snapshot => {
      state.places = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    })
  );

  state.unsubscribe.push(
    onSnapshot(expensesRef, snapshot => {
      state.expenses = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    })
  );

  state.unsubscribe.push(
    onSnapshot(bookingsRef, snapshot => {
      state.bookings = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(b => String(b.status || "").toLowerCase() !== "deleted" && !b.deletedAt);
      state._allBookings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    })
  );

  state.unsubscribe.push(
    onSnapshot(checklistRef, snapshot => {
      state.checklist = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    })
  );

  state.unsubscribe.push(
    onSnapshot(dspRef, snapshot => {
      state.dsp = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(item => item.id !== "main");

      const main = snapshot.docs.find(d => d.id === "main");
      state.dspMain = main?.data() || null;
      render();
    })
  );
}


/* =========================================================
   MAP BUTTONS
========================================================= */

function mapButtons(placeId) {
  if (!placeId) return "";
  const place = state.places.find(p => p.id === placeId);
  if (!place) return "";
  const hasCoord = Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng));
  if (!hasCoord && !place.name && !place.naverMapsUrl && !place.googleMapsUrl) return "";
  // Mặc định mở app (Naver theo tọa độ). Nút "…" mở chooser.
  return `
    <button type="button" class="btn sm blue" onclick="openPlaceMaps('${escapeHtml(placeId)}')">🗺 Map</button>
    <button type="button" class="btn sm" onclick="openPlaceMaps('${escapeHtml(placeId)}',{chooser:true})">…</button>
  `;
}


/* =========================================================
   ACTIVITY HTML
========================================================= */

function activityHtml(activity) {
  return `
    <div class="activity ${activity.mode === "fixed" ? "fixed" : "flexible"}">
      <div class="activity-time">
        ${escapeHtml(activity.startTime)}
        <br>
        <span class="muted">${escapeHtml(activity.endTime)}</span>
      </div>
      <div>
        <div class="activity-title">${escapeHtml(activity.title)}</div>
        <div class="activity-place">
          ${activity.placeId
            ? `<span class="place-link" onclick="openPlaceDetail('${escapeHtml(activity.placeId)}')">📍 ${escapeHtml(placeName(activity.placeId))}</span>`
            : "📍 —"}
          · ${escapeHtml(activity.mode || "flexible")}
          ${activity.dspAttractionId ? ' · <span class="pill blue">DSP</span>' : ""}
          ${activity.placeId ? ` · <span class="place-link" style="color:#3730a3;font-weight:600" onclick="openPlaceDetail('${escapeHtml(activity.placeId)}')">Chi tiết</span>` : ""}
        </div>
        ${
          activity.notes
            ? `<div class="activity-note">${escapeHtml(activity.notes)}</div>`
            : ""
        }
      </div>
      <div class="actions">
        ${activity.placeId ? `<button type="button" class="btn sm blue" onclick="openPlaceMaps('${escapeHtml(activity.placeId)}')">🗺 Map</button>` : ""}
        <button class="btn" onclick="editActivity('${escapeHtml(activity.id)}')">Sửa</button>
        <button class="btn danger" onclick="removeActivity('${escapeHtml(activity.id)}')">Ẩn</button>
      </div>
    </div>
  `;
}



function minsToTime(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2,"0") + ":" + String(mm).padStart(2,"0");
}
function dayBufferMinutes(day) {
  return activeActivities().filter(a => a.date === day)
    .reduce((s, a) => s + (Number(a.bufferMinutesAfter) || 0), 0);
}
function freeWindows(day) {
  const list = activeActivities().filter(a => a.date === day).slice()
    .sort((a,b) => String(a.startTime||"").localeCompare(String(b.startTime||"")));
  const windows = [];
  for (let i = 0; i < list.length - 1; i++) {
    const endA = minutes(list[i].endTime) || minutes(list[i].startTime) + 60;
    const startB = minutes(list[i+1].startTime);
    const gap = startB - endA;
    if (gap >= 15) {
      windows.push({
        from: minsToTime(endA), to: minsToTime(startB), minutes: gap,
        after: list[i].title, before: list[i+1].title
      });
    }
  }
  return windows;
}
function scheduleHealth(day, now = new Date()) {
  const classified = (typeof classifyDayActivities === "function")
    ? classifyDayActivities(day, now)
    : [];
  // Fallback simple health if classify not available at call time
  const todayStr = localDateString(now);
  if (day !== todayStr) {
    return { level: "gray", text: day < todayStr ? "Ngày đã qua" : "Ngày sắp tới" };
  }
  const nowMin = localTimeMinutes(now);
  const dayActs = activeActivities().filter(a => a.date === day)
    .sort((a,b) => String(a.startTime||"").localeCompare(String(b.startTime||"")));
  for (const a of dayActs) {
    const st = String(a.status||"").toLowerCase();
    if (st === "done" || st === "skipped") continue;
    const start = minutes(a.startTime);
    const end = minutes(a.endTime) || start + 60;
    if (nowMin >= start && nowMin < end) {
      return { level: "green", text: "🟢 Đúng lịch · " + (a.title||"") };
    }
    if (nowMin > start + 10 && nowMin < start) { /* noop */ }
    if (a.mode === "fixed" && nowMin > start + 10 && nowMin < end) {
      /* already in */
    }
    if (a.mode === "fixed" && nowMin > end && st !== "done") {
      /* past */
    }
  }
  // upcoming
  for (const a of dayActs) {
    const st = String(a.status||"").toLowerCase();
    if (st === "done" || st === "skipped") continue;
    const start = minutes(a.startTime);
    if (nowMin < start) {
      const until = start - nowMin;
      if (until <= 15) return { level: "yellow", text: "🟡 Sắp tới: " + (a.title||"") + " (" + until + "p)" };
      return { level: "green", text: "🟢 On schedule · còn " + until + "p" };
    }
    if (nowMin >= start && nowMin < (minutes(a.endTime)||start+60)) {
      return { level: "green", text: "🟢 Đúng lịch" };
    }
  }
  if (dayActs.length) return { level: "green", text: "🟢 Xong ngày / giữa các slot" };
  return { level: "gray", text: "Chưa có lịch" };
}

function analyzeImpact(newAct) {
  const day = newAct.date;
  const newStart = minutes(newAct.startTime);
  const newEnd = minutes(newAct.endTime) || newStart + 60;
  const existing = activeActivities().filter(a => a.date === day)
    .sort((a,b) => String(a.startTime||"").localeCompare(String(b.startTime||"")));
  const effects = [];
  let hasFixedConflict = false;
  for (const a of existing) {
    const aStart = minutes(a.startTime);
    const aEnd = minutes(a.endTime) || aStart + 60;
    if (newStart < aEnd && newEnd > aStart) {
      if (a.mode === "fixed") hasFixedConflict = true;
      effects.push(a.mode === "fixed"
        ? "⚠ Xung đột FIXED: " + a.title + " (" + a.startTime + "–" + a.endTime + ")"
        : "Chồng giờ flexible: " + a.title + " (" + a.startTime + "–" + a.endTime + ")");
    } else if (aStart >= newEnd) {
      effects.push("Activity sau: " + a.title + " lúc " + a.startTime + " · gap " + (aStart - newEnd) + "p");
      break;
    }
  }
  for (let i = existing.length - 1; i >= 0; i--) {
    const a = existing[i];
    const aEnd = minutes(a.endTime) || minutes(a.startTime) + 60;
    if (aEnd <= newStart) {
      const gap = newStart - aEnd;
      const travel = Number(a.travelMinutesToNext) || 0;
      effects.unshift("Trước đó: " + a.title + " · gap " + gap + "p" + (travel ? " · travel " + travel + "p" : ""));
      if (travel && gap < travel) effects.unshift("⚠ Gap " + gap + "p < travelMinutesToNext " + travel + "p");
      break;
    }
  }
  return { effects, hasFixedConflict };
}

function openImpactForm() {
  const dates = [...new Set([
    ...state.activities.map(a => a.date),
    "2026-10-18","2026-10-19","2026-10-20","2026-10-21",
    "2026-10-22","2026-10-23","2026-10-24","2026-10-25"
  ])].sort();
  openModal("Thêm có Impact Preview", `
    <form id="impactForm" class="form">
      <div class="form-grid">
        <label>Ngày<select name="date">${dates.map(d =>
          `<option value="${d}" ${d===state.selectedDay?"selected":""}>${formatDay(d)}</option>`
        ).join("")}</select></label>
        <label>Địa điểm<select name="placeId"><option value="">—</option>${
          state.places.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")
        }</select></label>
      </div>
      <div class="form-grid">
        <label>Bắt đầu<input type="time" name="startTime" value="15:00" required></label>
        <label>Kết thúc<input type="time" name="endTime" value="16:00" required></label>
      </div>
      <label>Tên<input name="title" required placeholder="Cafe / phát sinh..."></label>
      <label>Kiểu<select name="mode"><option value="flexible">Flexible</option><option value="fixed">Fixed</option></select></label>
      <button type="button" class="btn primary" id="previewImpact">Xem ảnh hưởng</button>
    </form>
    <div id="impactPreview"></div>
  `);
  document.getElementById("previewImpact").onclick = () => {
    const data = Object.fromEntries(new FormData(document.getElementById("impactForm")).entries());
    showImpactPreview(data);
  };
}

function showImpactPreview(data) {
  const container = document.getElementById("impactPreview");
  if (!container) return;
  const result = analyzeImpact(data);
  let cls = "impact-box" + (result.hasFixedConflict ? " warn" : "");
  container.innerHTML = `
    <div class="${cls}">
      <b>ACTIVITY MỚI</b><br>
      ${escapeHtml(data.startTime)}–${escapeHtml(data.endTime)} · ${escapeHtml(data.title)}
      <div style="margin-top:8px">
        ${result.effects.length
          ? result.effects.map(m => `<div class="impact-row">${escapeHtml(m)}</div>`).join("")
          : `<div class="impact-row muted">Không ảnh hưởng activity khác.</div>`}
      </div>
      ${result.hasFixedConflict
        ? `<div class="impact-row" style="color:var(--red);font-weight:700">⚠ Có xung đột với activity cố định</div>`
        : ""}
      <div class="actions" style="margin-top:10px">
        <button class="btn" id="impactCancel">Hủy</button>
        <button class="btn primary" id="impactConfirm">Thêm vào lịch</button>
      </div>
    </div>
  `;
  document.getElementById("impactCancel").onclick = closeModal;
  document.getElementById("impactConfirm").onclick = async () => {
    try {
      await addDoc(tripRef, {
        date: data.date, startTime: data.startTime, endTime: data.endTime,
        title: data.title, placeId: data.placeId || "",
        mode: data.mode || "flexible", type: "other", status: "planned",
        createdAt: new Date().toISOString(), ...audit()
      });
      closeModal();
      showToast("Đã thêm activity");
    } catch (e) { alert(e.message); }
  };
}


/* =========================================================
   PHASE 2 — DASHBOARD "TODAY"
========================================================= */

function renderDashboard() {
  const element = document.getElementById("tab-dashboard");
  const now = new Date(state.nowTick);
  const todayStr = localDateString(now);

  // Today KHÔNG theo ngày chọn ở tab Lịch (state.selectedDay chỉ cho itinerary)
  // Trong trip → luôn ngày máy; ngoài trip → preview cố định TRIP_START
  let focusDay = todayStr;
  if (todayStr < TRIP_START || todayStr > TRIP_END) {
    focusDay = TRIP_START;
  } else {
    focusDay = todayStr;
  }

  const classified = classifyDayActivities(focusDay, now);
  const current = classified.find(c => c.state === "current");
  const upcoming = classified.filter(c => c.state === "upcoming");
  const doneCount = classified.filter(c => c.state === "done").length;
  const remainingCount = classified.filter(
    c => c.state === "current" || c.state === "upcoming"
  ).length;
  const next = upcoming[0] || null;

  let remainingText = "—";
  if (current) {
    const endMin = minutes(current.activity.endTime);
    const left = endMin - localTimeMinutes(now);
    remainingText = left > 0 ? `${left} phút` : "sắp kết thúc";
  }

  let nextStartText = "—";
  if (next) {
    nextStartText = next.activity.startTime || "—";
    if (focusDay === todayStr && next.activity.startTime) {
      const minsUntil = minutes(next.activity.startTime) - localTimeMinutes(now);
      if (minsUntil > 0) {
        nextStartText += ` (còn ${minsUntil} phút)`;
      }
    }
  }

  // Expenses today
  const expenseToday = activeExpenses()
    .filter(e => e.date === focusDay)
    .reduce((s, e) => s + Number(e.amount || 0), 0);

  // DSP summary
  const dspSummary = renderDSPMini();

  element.innerHTML = `
    <div class="hero">
      <div>
        <span class="pill blue">TODAY</span><span class="pill green" data-connection-state>Online</span>
        <h1 style="margin-top:8px">${formatDayLong(focusDay)}</h1>
        <div class="muted small">
          ${focusDay === todayStr
            ? now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
            : "Xem trước (thiết bị ngoài ngày trip)"}
        </div>
      </div>
      <div class="actions">
        <button class="btn" id="imHereBtn">📍 Tôi đang ở đây</button>
        <button class="btn blue" id="goItinerary">Lịch trình</button>
      </div>
    </div>

    <!-- NOW STATUS -->
    ${(function(){try{var h=scheduleHealth(focusDay,now);return '<div class="status-banner '+h.level+'">'+escapeHtml(h.text)+'</div>';}catch(e){return "";}})()}
    <div class="card now-card" style="margin-bottom:14px">
      <div class="grid grid-2">
        <div>
          <div class="now-label">Đang làm</div>
          <h2 style="margin:0">
            ${
              current
                ? escapeHtml(current.activity.title)
                : (upcoming.length
                    ? "Chưa bắt đầu activity"
                    : (classified.length ? "Đã xong ngày" : "Chưa có lịch"))
            }
          </h2>
          ${
            current
              ? `<div class="muted small" style="margin-top:4px">
                  ${escapeHtml(current.activity.startTime || "")} – ${escapeHtml(current.activity.endTime || "")}
                  · Còn ${remainingText}
                  <br>📍 ${escapeHtml(placeName(current.activity.placeId))}
                </div>`
              : ""
          }
        </div>
        <div>
          <div class="now-label">Tiếp theo</div>
          <h2 style="margin:0">
            ${next ? escapeHtml(next.activity.title) : "—"}
          </h2>
          ${
            next
              ? `<div class="muted small" style="margin-top:4px">
                  Bắt đầu: ${escapeHtml(nextStartText)}
                  <br>📍 ${escapeHtml(placeName(next.activity.placeId))}
                </div>`
              : ""
          }
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <span class="small" style="opacity:.85">
          ✓ ${doneCount} xong · ${remainingCount} còn lại · ${classified.length} tổng
        </span>
      </div>
    </div>

    <!-- STATS -->
    <div class="grid grid-3" style="margin-bottom:14px">
      <div class="card">
        <div class="stat">
          <div>
            <div class="small muted">Chi tiêu hôm nay</div>
            <strong style="font-size:18px">${money(expenseToday)}</strong>
          </div>
          💳
        </div>
      </div>
      <div class="card">
        <div class="stat">
          <div>
            <div class="small muted">Activities</div>
            <strong style="font-size:18px">${classified.length}</strong>
          </div>
          📅
        </div>
      </div>
      <div class="card">
        <div class="stat">
          <div>
            <div class="small muted">Địa điểm</div>
            <strong style="font-size:18px">${state.places.length}</strong>
          </div>
          📍
        </div>
      </div>
    </div>


    <div class="card" id="dayNoteCard" style="margin-bottom:12px">
      <div class="row" style="margin-bottom:6px">
        <h3 style="margin:0">📝 Ghi chú ngày</h3>
        <button type="button" class="btn sm" id="saveDayNoteBtn">Lưu</button>
      </div>
      <textarea id="dayNoteInput" rows="2" placeholder="Ghi 1–2 dòng cho ngày này…">${escapeHtml(state.dayNoteText || "")}</textarea>
    </div>

    ${(function(){
      try {
        var bs = (state.bookings||[]).filter(function(b){ return b.date === focusDay; });
        if (!bs.length) return "";
        return '<div class="card" style="margin-bottom:12px"><h3>✈️ Booking hôm nay</h3>' +
          bs.map(function(b){
            return '<div class="list-item"><div class="row"><div><b>'+escapeHtml(b.title||"")+'</b>'+
              '<div class="small muted">'+(b.time?escapeHtml(b.time)+" · ":"")+escapeHtml(b.type||"")+
              (b.confirmationCode?" · #"+escapeHtml(b.confirmationCode):"")+'</div></div>'+
              (b.url?'<button class="btn sm" onclick="window.open(\''+escapeHtml(b.url)+'\',\'_blank\')">Link</button>':'')+
              '</div></div>';
          }).join("") + '</div>';
      } catch(e) { return ""; }
    })()}

    ${dspSummary}

    ${(function(){try{var w=freeWindows(focusDay);if(!w.length)return "";return '<div class="card" style="margin-top:10px"><h3>🕐 Khoảng trống</h3>'+w.map(function(x){return '<div class="free-window"><b>'+escapeHtml(x.from)+' – '+escapeHtml(x.to)+'</b> · '+x.minutes+' phút<div class="small muted">Sau '+escapeHtml(x.after)+' · trước '+escapeHtml(x.before)+'</div></div>';}).join("")+'</div>';}catch(e){return "";}})()}
    <!-- TIMELINE -->
    <div class="card" style="margin-top:14px">
      <div class="row">
        <div>
          <h2>Timeline</h2>
          <div class="small muted">${formatDay(focusDay)}</div>
        </div>
        <span class="small muted">Chạm ✓ để đánh dấu xong</span>
      </div>
      <div class="timeline" style="margin-top:8px">
        ${
          classified.length
            ? classified.map(c => {
                const mark =
                  c.state === "done" ? "✓" :
                  c.state === "current" ? "→" :
                  c.state === "skipped" ? "–" : "○";
                const canMark = c.state !== "done" && c.state !== "skipped";
                const canUndo = c.state === "done" || c.state === "skipped";
                const placeId = c.activity.placeId || "";
                return `
                  <div class="tl-item ${c.state}" data-open-place="${escapeHtml(placeId)}">
                    <div class="tl-mark">${mark}</div>
                    <div class="tl-time">${escapeHtml(c.activity.startTime || "—")}</div>
                    <div class="tl-body">
                      <div class="tl-title tl-tap">${escapeHtml(c.activity.title || "—")}</div>
                      <div class="tl-meta tl-tap">
                        📍 ${escapeHtml(placeName(c.activity.placeId))}
                        ${c.activity.mode === "fixed" ? " · 🔒" : ""}
                        ${c.activity.dspAttractionId ? ' · <span class="pill blue">DSP</span>' : ""}
                        ${placeId ? ' · <span class="pill">Chi tiết</span>' : ""}
                      </div>
                      <div class="tl-actions">
                        ${canMark ? `<button type="button" class="btn sm" data-mark-done="${escapeHtml(c.activity.id)}">✓ Xong</button>` : ""}
                        ${canUndo ? `<button type="button" class="btn sm" data-mark-planned="${escapeHtml(c.activity.id)}">↩ Mở lại</button>` : ""}
                        ${c.state === "current" || c.state === "upcoming" ? `<button type="button" class="btn sm" data-mark-skip="${escapeHtml(c.activity.id)}">Bỏ qua</button>` : ""}
                        ${placeId ? `<button type="button" class="btn sm blue" data-open-maps="${escapeHtml(placeId)}">🗺 Map</button>` : ""}
                      </div>
                    </div>
                  </div>
                `;
              }).join("")
            : `<div class="empty">Chưa có activity cho ngày này.</div>`
        }
      </div>
    </div>

    <!-- I'M HERE RESULT SLOT -->
    <div id="hereResultSlot"></div>
  `;

  document.getElementById("imHereBtn").onclick = () => runImHere();


  const goIt = document.getElementById("goItinerary");
  if (goIt) {
    goIt.onclick = () => {
      state.tab = "itinerary";
      const btn = document.querySelector('#nav [data-tab="itinerary"], #navBottom [data-tab="itinerary"]');
      if (btn) btn.click();
      else switchTab && switchTab("itinerary");
    };
  }

  // Per-item mark done / undo / skip — works even outside trip calendar day
  element.querySelectorAll("[data-mark-done]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-mark-done");
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "activities", id), {
          status: "done", ...audit()
        });
        const act = state.activities.find(a => a.id === id);
        if (act?.dspAttractionId) {
          const attr = state.dsp.find(d => d.id === act.dspAttractionId);
          if (attr && !attr.visited && confirm("Đánh dấu DSP «" + (attr.name || "") + "» đã dùng?")) {
            await updateDoc(doc(db, "trips", TRIP_ID, "dsp", attr.id), {
              visited: true, ...audit()
            });
          }
        }
        showToast("Đã đánh dấu xong");
      } catch (err) { alert(err.message); }
    };
  });
  element.querySelectorAll("[data-mark-planned]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "activities", btn.getAttribute("data-mark-planned")), {
          status: "planned", ...audit()
        });
        showToast("Đã mở lại");
      } catch (err) { alert(err.message); }
    };
  });
  element.querySelectorAll("[data-mark-skip]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "activities", btn.getAttribute("data-mark-skip")), {
          status: "skipped", ...audit()
        });
        showToast("Đã bỏ qua");
      } catch (err) { alert(err.message); }
    };
  });

  element.querySelectorAll("[data-open-maps]").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openPlaceMaps(btn.getAttribute("data-open-maps"));
    };
  });
  element.querySelectorAll(".tl-tap").forEach(el => {
    el.style.cursor = "pointer";
    el.onclick = (e) => {
      e.stopPropagation();
      const row = el.closest("[data-open-place]");
      const pid = row && row.getAttribute("data-open-place");
      if (pid) openPlaceDetail(pid);
    };
  });

  loadDayNote(focusDay);
  const saveDayBtn = document.getElementById("saveDayNoteBtn");
  if (saveDayBtn) {
    saveDayBtn.onclick = async () => {
      const text = (document.getElementById("dayNoteInput") || {}).value || "";
      try {
        await setDoc(doc(db, "trips", TRIP_ID, "notes", "day-" + focusDay), {
          text, date: focusDay, ...audit()
        }, { merge: true });
        state.dayNoteText = text;
        showToast("Đã lưu ghi chú ngày");
      } catch (e) { alert(e.message); }
    };
  }
  try { checkUpcomingAlerts(); } catch (_) {}

}


function renderDSPMini() {
  if (!state.dspMain) {
    return `
      <div class="card">
        <div class="row">
          <div>
            <h3>🎫 Discover Seoul Pass</h3>
            <div class="muted small">Chưa có thông tin activation trong Firestore.</div>
          </div>
          <button class="btn" id="goDspMini">DSP</button>
        </div>
      </div>
    `;
  }

  const expires = new Date(state.dspMain.expiresAt);
  const activated = state.dspMain.activatedAt
    ? new Date(state.dspMain.activatedAt)
    : null;
  const remaining = Math.max(0, expires.getTime() - Date.now());
  const used = state.dsp
    .filter(i => i.visited)
    .reduce((s, i) => s + Number(i.normalPrice || 0), 0);
  const visitedCount = state.dsp.filter(i => i.visited).length;
  const totalAttr = state.dsp.length;

  const active = remaining > 0 && (!activated || Date.now() >= activated.getTime());

  return `
    <div class="card">
      <div class="row">
        <div>
          <h3>🎫 DSP ${active ? '<span class="pill green">ACTIVE</span>' : '<span class="pill gray">—</span>'}</h3>
          <div class="small muted">
            Còn ${formatCountdown(remaining)}
            · Đã dùng ${visitedCount}/${totalAttr}
            · ${money(used)}
          </div>
        </div>
        <button class="btn" id="goDspMini">Chi tiết</button>
      </div>
      <div class="progress" style="margin-top:10px">
        <i style="width:${Math.min(100, (remaining / (72 * 3600 * 1000)) * 100)}%"></i>
      </div>
    </div>
  `;
}


/* =========================================================
   PHASE 3 — I'M HERE (Geolocation)
========================================================= */

function runImHere() {
  const slot = document.getElementById("hereResultSlot");
  if (!slot) {
    // Open on dashboard
    state.tab = "dashboard";
    document.querySelector('[data-tab="dashboard"]').click();
    setTimeout(runImHere, 100);
    return;
  }

  slot.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="muted">Đang lấy vị trí…</div>
    </div>
  `;

  if (!navigator.geolocation) {
    slot.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="error">Trình duyệt không hỗ trợ Geolocation.</div>
      </div>
    `;
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;

      const withCoords = state.places.filter(p => {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        return Number.isFinite(lat) && Number.isFinite(lng);
      });

      if (!withCoords.length) {
        slot.innerHTML = `
          <div class="card" style="margin-top:14px">
            <div class="muted">Không có Place nào có tọa độ trong Firestore.</div>
          </div>
        `;
        return;
      }

      let nearest = null;
      let nearestM = Infinity;

      for (const place of withCoords) {
        const d = haversineM(latitude, longitude, Number(place.lat), Number(place.lng));
        if (d < nearestM) {
          nearestM = d;
          nearest = place;
        }
      }

      const distLabel =
        nearestM < 1000
          ? `${Math.round(nearestM)} m`
          : `${(nearestM / 1000).toFixed(2)} km`;

      slot.innerHTML = `
        <div class="card here-result" style="margin-top:14px">
          <div class="now-label" style="color:var(--muted)">📍 Bạn đang gần</div>
          <strong>${escapeHtml(nearest.name || "—")}</strong>
          <div class="small muted" style="margin-top:4px">
            Khoảng cách (đường chim bay): <b>${distLabel}</b>
            ${accuracy ? ` · GPS ±${Math.round(accuracy)} m` : ""}
          </div>
          <div class="actions" style="margin-top:10px">
            <button class="btn primary" onclick="openPlaceDetail('${escapeHtml(nearest.id)}')">Chi tiết</button>
            <button class="btn" onclick="openPlaceMaps('${escapeHtml(nearest.id)}')">🗺 Map</button>
          </div>
        </div>
      `;
    },
    err => {
      let msg = "Không lấy được vị trí.";
      if (err.code === 1) msg = "Bạn đã từ chối quyền vị trí.";
      if (err.code === 2) msg = "Vị trí không khả dụng.";
      if (err.code === 3) msg = "Hết thời gian chờ GPS.";
      slot.innerHTML = `
        <div class="card" style="margin-top:14px">
          <div class="error">${escapeHtml(msg)}</div>
        </div>
      `;
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
}

window.runImHere = runImHere;


/* =========================================================
   DAY MAP (Phase 1)
========================================================= */

function destroyDayMap() {
  if (dayMap) {
    try { dayMap.remove(); } catch (_) {}
    dayMap = null;
    dayMapLayerGroup = null;
  }
}


function renderDayMapDistances(points) {
  const container = document.getElementById("dayMapDistances");
  if (!container) return;
  if (points.length < 2) {
    container.innerHTML = points.length === 0
      ? `<div class="muted small">Chưa có đủ địa điểm có tọa độ.</div>`
      : `<div class="muted small">Chỉ có 1 địa điểm có tọa độ.</div>`;
    return;
  }

  const rows = [];
  let totalStraight = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const straightKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
    totalStraight += straightKm;
    rows.push(`
      <div class="route-segment">
        <div class="route-segment-head">
          <span><b>${i + 1} → ${i + 2}</b> <span class="muted">${escapeHtml(a.place.name)} → ${escapeHtml(b.place.name)}</span></span>
          <strong>${straightKm.toFixed(1)} km</strong>
        </div>
      </div>
    `);
  }

  container.innerHTML = `
    <div class="route-summary">
      <div><strong>Khoảng cách giữa các điểm</strong></div>
      <div class="small muted">${rows.length} chặng · khoảng ${totalStraight.toFixed(1)} km đường chim bay</div>
    </div>
    ${rows.join("")}
    <div class="day-map-note">Khoảng cách chỉ là khoảng cách đường chim bay, không phải quãng đường di chuyển thực tế.</div>
  `;
}

function initOrUpdateDayMap(day) {
  const mapEl = document.getElementById("dayMap");
  if (!mapEl) return;

  const points = getDayMapPoints(day);
  const defaultCenter = [37.5665, 126.9780];

  // #dayMap bị thay mỗi lần render itinerary → phải tạo map mới sạch
  if (dayMap) {
    try { dayMap.remove(); } catch (_) {}
    dayMap = null;
    dayMapLayerGroup = null;
  }
  // Xóa state Leaflet còn sót trên DOM node
  if (mapEl._leaflet_id) {
    try { delete mapEl._leaflet_id; } catch (_) { mapEl._leaflet_id = undefined; }
  }
  mapEl.innerHTML = "";

  dayMap = L.map(mapEl, {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
    fadeAnimation: false,
    zoomAnimation: true
  });

  // Tile layers miễn phí, không API key.
  // OSM.org đôi khi chặn/rate-limit từ VN/KR → ưu tiên mirror + ESRI.
  const tileBlank = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const layers = [
    L.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
      updateWhenIdle: true,
      keepBuffer: 2,
      errorTileUrl: tileBlank
    }),
    L.tileLayer("https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png", {
      maxZoom: 20,
      subdomains: "abc",
      attribution: "&copy; OpenStreetMap France",
      updateWhenIdle: true,
      errorTileUrl: tileBlank
    }),
    // ESRI World Street — thường vào được khi OSM bị chặn; không cần key cho usage nhẹ
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
      updateWhenIdle: true,
      errorTileUrl: tileBlank
    }),
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
      updateWhenIdle: true,
      errorTileUrl: tileBlank
    })
  ];

  let layerIndex = 0;
  let errorCount = 0;
  const active = layers[0];
  active.addTo(dayMap);
  dayMap._baseLayers = layers;
  dayMap._baseIndex = 0;

  function switchTileLayer() {
    if (layerIndex >= layers.length - 1) return;
    try { dayMap.removeLayer(layers[layerIndex]); } catch (_) {}
    layerIndex += 1;
    errorCount = 0;
    dayMap._baseIndex = layerIndex;
    layers[layerIndex].addTo(dayMap);
    console.info("[DayMap] switched tile layer →", layerIndex);
  }

  layers.forEach((layer, idx) => {
    layer.on("tileerror", () => {
      if (idx !== dayMap._baseIndex) return;
      errorCount += 1;
      // Nhiều tile lỗi liên tiếp → đổi nguồn
      if (errorCount >= 4) switchTileLayer();
    });
  });

  // Nút đổi nguồn map (khi OSM/mirror vẫn trắng)
  const switchBtnId = "dayMapSwitchTiles";
  setTimeout(() => {
    const host = document.getElementById("dayMapDistances");
    if (!host || document.getElementById(switchBtnId)) return;
    const row = document.createElement("div");
    row.style.cssText = "margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center";
    row.innerHTML = `<button type="button" class="btn sm" id="${switchBtnId}">Đổi nguồn bản đồ</button>
      <span class="small muted" id="dayMapTileLabel">Nguồn: OSM.de</span>`;
    host.parentNode.insertBefore(row, host);
    const labels = ["OSM.de", "OSM France", "Esri Street", "OSM.org"];
    document.getElementById(switchBtnId).onclick = () => {
      switchTileLayer();
      const lab = document.getElementById("dayMapTileLabel");
      if (lab) lab.textContent = "Nguồn: " + (labels[dayMap._baseIndex] || "?");
    };
  }, 100);

  dayMapLayerGroup = L.layerGroup().addTo(dayMap);

  const latLngs = [];
  points.forEach((pt, index) => {
    const num = index + 1;
    const icon = L.divIcon({
      className: "",
      html: `<div class="numbered-marker">${num}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14]
    });
    const marker = L.marker([pt.lat, pt.lng], { icon }).addTo(dayMapLayerGroup);
    const timeStr = [pt.activity.startTime || "", pt.activity.endTime || ""]
      .filter(Boolean).join(" – ");
    let popupHtml = `<b>${escapeHtml(pt.place.name || "—")}</b><br>
      <span style="color:#64748b">${escapeHtml(timeStr || "—")}</span>`;
    if (pt.activity.notes) {
      popupHtml += `<br><span style="color:#64748b;font-size:12px">${escapeHtml(pt.activity.notes)}</span>`;
    }
    // Mở app theo tọa độ qua openPlaceMaps (không web search theo tên)
    const pid = pt.place.id || pt.activity.placeId || "";
    if (pid) {
      popupHtml += `<div class="popup-actions">
        <a href="#" class="popup-open-detail" data-place-id="${escapeHtml(pid)}">Chi tiết</a>
        ·
        <a href="#" class="popup-open-map" data-place-id="${escapeHtml(pid)}">🗺 Map</a>
      </div>`;
    }
    marker.bindPopup(popupHtml);
    marker.on("popupopen", () => {
      document.querySelectorAll(".popup-open-map[data-place-id]").forEach(link => {
        link.onclick = (e) => {
          e.preventDefault();
          openPlaceMaps(link.getAttribute("data-place-id"));
        };
      });
      document.querySelectorAll(".popup-open-detail[data-place-id]").forEach(link => {
        link.onclick = (e) => {
          e.preventDefault();
          openPlaceDetail(link.getAttribute("data-place-id"));
        };
      });
    });
    latLngs.push([pt.lat, pt.lng]);
  });

  if (latLngs.length >= 2) {
    L.polyline(latLngs, {
      color: "#2563eb", weight: 3, opacity: 0.75, dashArray: "6 8"
    }).addTo(dayMapLayerGroup);
  }

  if (latLngs.length === 0) {
    dayMap.setView(defaultCenter, 11);
  } else if (latLngs.length === 1) {
    dayMap.setView(latLngs[0], 14);
  } else {
    dayMap.fitBounds(latLngs, { padding: [36, 36], maxZoom: 15 });
  }

  // Container mobile thường layout chậm → invalidateSize lặp
  const fixSize = () => { if (dayMap) dayMap.invalidateSize({ animate: false }); };
  requestAnimationFrame(fixSize);
  setTimeout(fixSize, 100);
  setTimeout(fixSize, 350);
  setTimeout(fixSize, 800);

  renderDayMapDistances(points);
}


/* =========================================================
   ITINERARY
========================================================= */

function renderDaySummary(day) {
  const items = activeActivities().filter(a => a.date === day).slice().sort((a,b) => String(a.startTime||"").localeCompare(String(b.startTime||"")));
  const withPlace = items.filter(a => a.placeId);
  const totalMinutes = items.reduce((sum,a) => {
    const s=minutes(a.startTime), e=minutes(a.endTime);
    return sum + Math.max(0, e-s);
  },0);
  const hours=Math.floor(totalMinutes/60), mins=totalMinutes%60;
  return `<div class="day-summary">
    <div><strong>${items.length}</strong><span>activities</span></div>
    <div><strong>${hours ? hours+"h " : ""}${mins}m</strong><span>scheduled</span></div>
    <div><strong>${withPlace.length}</strong><span>map points</span></div>
  </div>`;
}


function renderItinerary() {
  const element = document.getElementById("tab-itinerary");

  const days = [...new Set(state.activities.map(a => a.date))].sort();

  if (days.length && !days.includes(state.selectedDay)) {
    state.selectedDay = days[0];
  }

  element.innerHTML = `
    <div class="hero">
      <div>
        <span class="pill">ITINERARY</span>
        <h1>Lịch trình</h1>
        <div class="muted">🔒 Fixed · ◇ Flexible</div>
      </div>
      <button class="btn primary" id="addActivity">+ Activity</button>
      <button class="btn" id="impactAdd">⚡ Impact</button>
    </div>

    <div class="day-summary-wrap">${renderDaySummary(state.selectedDay)}</div>

    <div class="day-tabs">
      ${
        days.map(day => `
          <button
            class="btn ${day === state.selectedDay ? "active" : ""}"
            data-day="${day}"
          >
            ${formatDay(day)}
          </button>
        `).join("")
      }
    </div>

    <div class="card day-map-wrap">
      <div class="row" style="margin-bottom:8px">
        <div>
          <h3>Bản đồ ngày</h3>
          <div class="small muted">${formatDay(state.selectedDay)}</div>
        </div>
      </div>
      <div id="dayMap"></div>
      <div id="dayMapDistances" class="day-map-distances"></div>
    </div>

    <div class="card" style="margin-top:12px">
      <h2>${formatDay(state.selectedDay)}</h2>
      <div class="timeline">
        ${
          state.activities
            .filter(a => a.date === state.selectedDay)
            .map(activityHtml)
            .join("")
          || `<div class="empty">Chưa có activity.</div>`
        }
      </div>
    </div>
  `;

  element.querySelectorAll("[data-day]").forEach(button => {
    button.onclick = () => {
      state.selectedDay = button.dataset.day;
      render();
    };
  });

  document.getElementById("addActivity").onclick = () => openActivityForm();
  const _ib=document.getElementById("impactAdd"); if(_ib)_ib.onclick=()=>openImpactForm();

  if (state.tab === "itinerary") {
    requestAnimationFrame(() => initOrUpdateDayMap(state.selectedDay));
  } else {
    destroyDayMap();
  }
}


/* =========================================================
   ACTIVITY FORM
========================================================= */

function openActivityForm(activityId = null) {
  const activity = activityId
    ? state.activities.find(a => a.id === activityId)
    : null;

  const dates = [
    ...new Set([
      ...state.activities.map(a => a.date),
      "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21",
      "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"
    ])
  ].sort();

  openModal(
    activity ? "Sửa activity" : "Thêm activity",
    `
      <form id="activityForm" class="form">
        <div class="form-grid">
          <label>
            Ngày
            <select name="date">
              ${dates.map(day => `
                <option value="${day}" ${
                  day === (activity?.date || state.selectedDay) ? "selected" : ""
                }>${formatDay(day)}</option>
              `).join("")}
            </select>
          </label>
          <label>
            Địa điểm
            <select name="placeId">
              <option value="">— Không chọn —</option>
              ${state.places.map(place => `
                <option value="${escapeHtml(place.id)}" ${
                  place.id === activity?.placeId ? "selected" : ""
                }>${escapeHtml(place.name)}</option>
              `).join("")}
            </select>
          </label>
        </div>
        <div class="form-grid">
          <label>
            Bắt đầu
            <input type="time" name="startTime" value="${activity?.startTime || "09:00"}" required>
          </label>
          <label>
            Kết thúc
            <input type="time" name="endTime" value="${activity?.endTime || "10:00"}" required>
          </label>
        </div>
        <label>
          Tên activity
          <input name="title" required value="${escapeHtml(activity?.title || "")}">
        </label>
        <div class="form-grid">
          <label>
            Loại
            <select name="type">
              ${["sightseeing","food","shopping","transport","rest","flight","other"].map(type => `
                <option value="${type}" ${type === (activity?.type || "sightseeing") ? "selected" : ""}>${type}</option>
              `).join("")}
            </select>
          </label>
          <label>
            Kiểu
            <select name="mode">
              <option value="fixed" ${activity?.mode === "fixed" ? "selected" : ""}>Fixed</option>
              <option value="flexible" ${activity?.mode !== "fixed" ? "selected" : ""}>Flexible</option>
            </select>
          </label>
        </div>
        <label>
          Ghi chú
          <textarea name="notes">${escapeHtml(activity?.notes || "")}</textarea>
        </label>
        <div class="actions">
          <button class="btn primary">Lưu</button>
          ${
            activity
              ? `<button type="button" class="btn danger" id="deleteActivity">Xóa</button>`
              : ""
          }
        </div>
      </form>
    `
  );

  document.getElementById("activityForm").onsubmit = async event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target).entries());

    try {
      if (activity) {
        await updateDoc(
          doc(db, "trips", TRIP_ID, "activities", activity.id),
          { ...form, ...audit() }
        );
      } else {
        await addDoc(tripRef, {
          ...form,
          status: "planned",
          createdAt: new Date().toISOString(),
          ...audit()
        });
      }
      closeModal();
      showToast("Đã lưu activity");
    } catch (error) {
      alert(error.message);
    }
  };

  if (activity) {
    document.getElementById("deleteActivity").onclick = () =>
      removeActivity(activity.id);
  }
}

window.editActivity = openActivityForm;

window.removeActivity = async function (id) {
  if (!confirm("Ẩn activity này? (có thể khôi phục sau)")) return;
  try {
    await updateDoc(doc(db, "trips", TRIP_ID, "activities", id), {
      status: "deleted",
      deletedAt: new Date().toISOString(),
      ...audit()
    });
    closeModal();
    showToast("Đã ẩn activity — có thể khôi phục");
  } catch (error) {
    alert(error.message);
  }
};

window.restoreActivity = async function (id) {
  try {
    await updateDoc(doc(db, "trips", TRIP_ID, "activities", id), {
      status: "planned",
      deletedAt: null,
      ...audit()
    });
    showToast("Đã khôi phục activity");
  } catch (error) {
    alert(error.message);
  }
};


/* =========================================================
   PHASE 7 (gọn) — DSP CONTROL
========================================================= */

function renderDSP() {
  const element = document.getElementById("tab-dsp");

  const used = state.dsp
    .filter(item => item.visited)
    .reduce((sum, item) => sum + Number(item.normalPrice || 0), 0);

  const visitedCount = state.dsp.filter(i => i.visited).length;
  const plannedCount = state.dsp.filter(i => i.planned).length;

  let countdownHtml = "";
  let statusPill = '<span class="pill gray">Chưa kích hoạt</span>';

  if (state.dspMain?.expiresAt) {
    const expires = new Date(state.dspMain.expiresAt);
    const remaining = Math.max(0, expires.getTime() - Date.now());
    const activated = state.dspMain.activatedAt
      ? new Date(state.dspMain.activatedAt)
      : null;
    const isActive =
      remaining > 0 &&
      (!activated || Date.now() >= activated.getTime());

    statusPill = isActive
      ? '<span class="pill green">ACTIVE</span>'
      : remaining <= 0
        ? '<span class="pill red">HẾT HẠN</span>'
        : '<span class="pill orange">Chưa tới giờ</span>';

    countdownHtml = `
      <div class="card" style="margin-top:14px">
        <div class="stat">
          <div>
            <h3>Còn lại</h3>
            <div class="small muted">Hết hạn: ${expires.toLocaleString("vi-VN")}</div>
          </div>
          <strong>${formatCountdown(remaining)}</strong>
        </div>
        <div class="progress" style="margin-top:10px">
          <i style="width:${Math.min(100, (remaining / (72 * 3600 * 1000)) * 100)}%"></i>
        </div>
      </div>
    `;
  }

  element.innerHTML = `
    <div class="hero">
      <div>
        <span class="pill orange">DISCOVER SEOUL PASS</span>
        <h1>DSP ${statusPill}</h1>
        <div class="muted">72 giờ · dữ liệu từ Firestore</div>
      </div>
    </div>

    <div class="grid grid-3">
      <div class="card">
        <div class="small muted">Activation</div>
        <h2 style="font-size:16px">
          ${
            state.dspMain?.activatedAt
              ? new Date(state.dspMain.activatedAt).toLocaleString("vi-VN")
              : "—"
          }
        </h2>
      </div>
      <div class="card">
        <div class="small muted">Expiration</div>
        <h2 style="font-size:16px">
          ${
            state.dspMain?.expiresAt
              ? new Date(state.dspMain.expiresAt).toLocaleString("vi-VN")
              : "—"
          }
        </h2>
      </div>
      <div class="card">
        <div class="small muted">Giá trị đã dùng</div>
        <h2>${money(used)}</h2>
        <div class="small muted">${visitedCount} attraction · ${plannedCount} đã lên lịch</div>
      </div>
    </div>

    ${countdownHtml}

    <div class="card" style="margin-top:14px">
      <h2>Attractions</h2>
      <div>
        ${
          state.dsp.map(item => `
            <div class="list-item">
              <div class="row">
                <div>
                  <b>${escapeHtml(item.name)}</b>
                  <div class="small muted">
                    ${money(item.normalPrice)} · FREE với DSP
                    ${item.visited ? ' · <span class="pill green">Đã dùng</span>' : ""}
                    ${item.planned && !item.visited ? ' · <span class="pill blue">Đã lên lịch</span>' : ""}
                  </div>
                </div>
                <div class="actions">
                  <button
                    class="btn ${item.planned ? "blue" : ""}"
                    onclick="toggleDSP('${escapeHtml(item.id)}','planned')"
                  >
                    ${item.planned ? "✓ Lịch" : "Lên lịch"}
                  </button>
                  <button
                    class="btn ${item.visited ? "green" : ""}"
                    onclick="toggleDSP('${escapeHtml(item.id)}','visited')"
                  >
                    ${item.visited ? "✓ Dùng" : "Đã dùng"}
                  </button>
                </div>
              </div>
            </div>
          `).join("")
          || `<div class="empty">Chưa có dữ liệu DSP.</div>`
        }
      </div>
    </div>
  `;
}


window.toggleDSP = async function (id, field) {
  const item = state.dsp.find(x => x.id === id);
  if (!item) return;
  await updateDoc(doc(db, "trips", TRIP_ID, "dsp", id), {
    [field]: !item[field],
    ...audit()
  });
};


/* =========================================================
   EXPENSES
========================================================= */

function renderExpenses() {
  const element = document.getElementById("tab-expenses");

  const total = activeExpenses().reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );

  const todayStr = localDateString();
  const todayTotal = activeExpenses()
    .filter(e => e.date === todayStr)
    .reduce((s, e) => s + Number(e.amount || 0), 0);

  element.innerHTML = `
    <div class="hero">
      <div>
        <span class="pill">MONEY</span>
        <h1>Chi tiêu</h1>
        <div class="muted">
          Tổng: <b>${money(total)}</b>
          · Hôm nay: <b>${money(todayTotal)}</b>
        </div>
      </div>
      <button class="btn primary" id="addExpense">+ Khoản chi</button>
    </div>

    <div class="grid grid-3">
      ${(() => {
        const preset = ["food", "transport", "shopping", "ticket"];
        const fromData = [...new Set(activeExpenses().map(e => e.category).filter(Boolean))];
        const cats = [...preset];
        fromData.forEach(c => { if (!cats.includes(c)) cats.push(c); });
        return cats.map(category => {
          const sum = activeExpenses()
            .filter(item => item.category === category)
            .reduce((s, item) => s + Number(item.amount || 0), 0);
          if (!preset.includes(category) && sum === 0) return "";
          return `
            <div class="card">
              <div class="small muted">${escapeHtml(category)}</div>
              <h2>${money(sum)}</h2>
            </div>`;
        }).join("");
      })()}
    </div>

    <div class="card" style="margin-top:14px">
      ${
        activeExpenses().length
          ? activeExpenses()
              .sort((a, b) => {
                const dc = String(b.date || "").localeCompare(String(a.date || ""));
                if (dc) return dc;
                return String(b.time || "").localeCompare(String(a.time || ""));
              })
              .map(item => `
                <div class="list-item">
                  <div class="row">
                    <div style="min-width:0">
                      <b>${escapeHtml(item.description || "—")}</b>
                      <div class="small muted">
                        ${escapeHtml(item.date || "")}
                        ${item.time ? " · " + escapeHtml(item.time) : ""}
                        · ${escapeHtml(item.category || "")}
                        ${item.payer ? " · " + escapeHtml(item.payer) : ""}
                        ${item.placeId ? " · 📍 " + escapeHtml(placeName(item.placeId)) : ""}
                      </div>
                    </div>
                    <div class="actions" style="flex-shrink:0">
                      <strong>${money(item.amount)}</strong>
                      <button class="btn sm danger" onclick="removeExpense('${escapeHtml(item.id)}')">Ẩn</button>
                    </div>
                  </div>
                </div>
              `).join("")
          : `<div class="empty">Chưa có khoản chi.</div>`
      }
    </div>
  `;

  document.getElementById("addExpense").onclick = openExpenseForm;
}


function openExpenseForm() {
  const now = new Date();
  const defaultTime = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const defaultDate = state.selectedDay || localDateString();

  openModal(
    "Thêm khoản chi",
    `
      <form id="expenseForm" class="form">
        <label class="exp-amount-wrap">
          Số tiền (KRW)
          <input type="number" name="amount" min="0" step="1" required inputmode="numeric" placeholder="0" enterkeyhint="next">
        </label>

        <label>
          Mô tả
          <input name="description" required placeholder="Cafe, taxi, cơm…" autocomplete="off" enterkeyhint="done">
        </label>

        <div class="form-grid">
          <label>
            Ngày
            <input type="date" name="date" value="${defaultDate}" required>
          </label>
          <label>
            Giờ
            <input type="time" name="time" value="${defaultTime}">
          </label>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:13px;font-weight:650;color:#475569">Danh mục</div>
          <div class="seg" id="expCatSeg" role="group" aria-label="Danh mục">
            <button type="button" data-cat="food" class="on">🍜 Ăn</button>
            <button type="button" data-cat="transport">🚇 Đi lại</button>
            <button type="button" data-cat="shopping">🛍 Mua</button>
            <button type="button" data-cat="ticket">🎫 Vé</button>
            <button type="button" data-cat="__custom">… Khác</button>
          </div>
          <input type="hidden" name="category" id="expCategory" value="food">
          <div id="expCustomCatWrap" class="hidden" style="margin-top:10px">
            <input type="text" id="expCustomCat" placeholder="Tên danh mục (vd: quà, sim, bảo hiểm…)" autocomplete="off" maxlength="40" style="width:100%;min-height:46px;font-size:16px;border-radius:12px;padding:12px;box-sizing:border-box">
          </div>
        </div>

        <details style="margin-bottom:14px">
          <summary style="font-size:13px;font-weight:650;color:#475569;cursor:pointer;padding:8px 0">Gắn địa điểm / activity (tuỳ chọn)</summary>
          <label style="margin-top:8px">
            Địa điểm
            <select name="placeId" id="expPlaceId">
              <option value="">— Không gắn —</option>
              ${(state.places || []).slice().sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""))).map(p =>
                `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`
              ).join("")}
            </select>
          </label>
          <label>
            Activity
            <select name="activityId" id="expActivityId">
              <option value="">— Không gắn —</option>
              ${(typeof activeActivities === "function" ? activeActivities() : state.activities)
                .filter(a => a.date === defaultDate)
                .map(a =>
                  `<option value="${escapeHtml(a.id)}">${escapeHtml((a.startTime || "") + " " + (a.title || ""))}</option>`
                ).join("")}
            </select>
          </label>
        </details>

        <button type="submit" class="btn primary" style="width:100%;min-height:52px;font-size:17px;margin-top:4px">Lưu khoản chi</button>
      </form>
    `
  );

  const customWrap = document.getElementById("expCustomCatWrap");
  const customInput = document.getElementById("expCustomCat");
  document.querySelectorAll("#expCatSeg button").forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll("#expCatSeg button").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      const cat = btn.getAttribute("data-cat");
      const hidden = document.getElementById("expCategory");
      if (cat === "__custom") {
        if (hidden) hidden.value = "";
        if (customWrap) customWrap.classList.remove("hidden");
        if (customInput) {
          customInput.value = "";
          setTimeout(() => customInput.focus(), 50);
        }
      } else {
        if (hidden) hidden.value = cat;
        if (customWrap) customWrap.classList.add("hidden");
        if (customInput) customInput.value = "";
      }
    };
  });

  document.getElementById("expenseForm").onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    data.amount = Number(data.amount);
    // Danh mục: preset hoặc custom khi chọn "Khác"
    const customVal = ((document.getElementById("expCustomCat") || {}).value || "").trim();
    const catHidden = (data.category || "").trim();
    if (customVal) {
      data.category = customVal;
    } else if (!catHidden || catHidden === "__custom") {
      alert("Nhập tên danh mục hoặc chọn một danh mục có sẵn");
      return;
    }
    delete data.payer;
    if (!data.time) delete data.time;
    if (!data.placeId) delete data.placeId;
    if (!data.activityId) delete data.activityId;
    try {
      await addDoc(expensesRef, { ...data, status: "active", ...audit() });
      closeModal();
      showToast("Đã thêm khoản chi");
    } catch (err) {
      alert(err.message);
    }
  };

  // Focus amount for quick entry
  setTimeout(() => {
    const amt = document.querySelector('#expenseForm input[name="amount"]');
    if (amt) amt.focus();
  }, 100);
}


window.removeExpense = async function (id) {
  if (!confirm("Ẩn khoản chi này? (có thể khôi phục)")) return;
  await updateDoc(doc(db, "trips", TRIP_ID, "expenses", id), {
    status: "deleted",
    deletedAt: new Date().toISOString(),
    ...audit()
  });
  showToast("Đã ẩn khoản chi");
};
window.restoreExpense = async function (id) {
  await updateDoc(doc(db, "trips", TRIP_ID, "expenses", id), {
    status: "active",
    deletedAt: null,
    ...audit()
  });
  showToast("Đã khôi phục khoản chi");
};

window.purgeActivity = async function (id) {
  if (!confirm("XÓA VĨNH VIỄN activity này? Không khôi phục được.")) return;
  try {
    await deleteDoc(doc(db, "trips", TRIP_ID, "activities", id));
    showToast("Đã xóa vĩnh viễn");
  } catch (e) { alert(e.message); }
};
window.purgeExpense = async function (id) {
  if (!confirm("XÓA VĨNH VIỄN khoản chi này? Không khôi phục được.")) return;
  try {
    await deleteDoc(doc(db, "trips", TRIP_ID, "expenses", id));
    showToast("Đã xóa vĩnh viễn");
  } catch (e) { alert(e.message); }
};
window.purgeBooking = async function (id) {
  if (!confirm("XÓA VĨNH VIỄN booking này? Không khôi phục được.")) return;
  try {
    await deleteDoc(doc(db, "trips", TRIP_ID, "bookings", id));
    showToast("Đã xóa vĩnh viễn");
  } catch (e) { alert(e.message); }
};



/* =========================================================
   PLACES
========================================================= */

function renderPlaces() {
  const element = document.getElementById("tab-places");

  element.innerHTML = `
    <div class="hero">
      <div>
        <span class="pill">PLACES</span>
        <h1>Địa điểm</h1>
        <div class="muted">${state.places.length} địa điểm</div>
      </div>
      <button class="btn" id="imHerePlaces">📍 Tôi đang ở đây</button>
    </div>

    <div class="card">
      <input id="placeSearch" placeholder="Tìm địa điểm...">
      <div id="placeList" style="margin-top:8px">
        ${placeListHtml(state.places)}
      </div>
    </div>
    <div id="hereResultSlotPlaces"></div>
  `;

  document.getElementById("placeSearch").oninput = event => {
    const keyword = event.target.value.toLowerCase().trim();
    document.getElementById("placeList").innerHTML = placeListHtml(
      state.places.filter(place =>
        String(place.name || "").toLowerCase().includes(keyword)
      )
    );
  };

  document.getElementById("imHerePlaces").onclick = () => {
    // Reuse same logic but target places slot via temporary redirect to dashboard slot
    state.tab = "dashboard";
    document.querySelector('[data-tab="dashboard"]').click();
    setTimeout(() => runImHere(), 120);
  };
}


function placeListHtml(places) {
  if (!places.length) {
    return `<div class="empty">Không tìm thấy.</div>`;
  }

  return places.map(place => `
    <div class="list-item">
      <div class="row">
        <div class="place-link" style="min-width:0;flex:1" onclick="openPlaceDetail('${escapeHtml(place.id)}')">
          <b>${escapeHtml(place.name)}</b>
          <div class="small muted">
            ${escapeHtml(place.area || place.category || "")}
            ${place.area || place.category ? " · " : ""}
            ${place.lat != null ? place.lat : "—"},
            ${place.lng != null ? place.lng : "—"}
            ${place.personalNote ? " · 📝" : ""}
          </div>
        </div>
        <div class="actions" style="flex-shrink:0">
          <button type="button" class="btn sm" onclick="openPlaceDetail('${escapeHtml(place.id)}')">Chi tiết</button>
          ${mapButtons(place.id)}
        </div>
      </div>
    </div>
  `).join("");
}


/* =========================================================
   MORE
========================================================= */

function renderMore() {
  const element = document.getElementById("tab-more");
  const bookings = (state.bookings || []).slice().sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || "")) ||
    String(a.time || "").localeCompare(String(b.time || ""))
  );
  const deleted = state.activities.filter(a => isDeletedActivity(a));
  const deletedExp = state.expenses.filter(e => {
    const st = String(e.status || "").toLowerCase();
    return st === "deleted" || !!e.deletedAt;
  });
  const deletedBookings = (state._allBookings || []).filter(b => {
    const st = String(b.status || "").toLowerCase();
    return st === "deleted" || !!b.deletedAt;
  });

  element.innerHTML = `
    <div class="hero">
      <div>
        <span class="pill">TOOLS</span>
        <h1>Khác</h1>
        <div class="muted">Booking · ghi chú · backup</div>
      </div>
    </div>

    <div class="card more-nav-card" style="margin-bottom:12px">
      <div class="small muted" style="margin-bottom:8px">Truy cập nhanh</div>
      <div class="more-nav-grid">
        <button class="btn" data-more-tab="places">📍 Địa điểm</button>
        <button class="btn" data-more-tab="dsp">🎫 Discover Seoul Pass</button>
        <button class="btn" data-more-tab="itinerary">🗓 Lịch trình</button>
        <button class="btn" data-more-tab="expenses">₩ Chi tiêu</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px" id="checklistCard">
      <div class="row" style="margin-bottom:8px">
        <div>
          <h2>🧳 Checklist packing</h2>
          <div class="small muted">Tick khi đã chuẩn bị · Ẩn / xóa trong thùng rác</div>
        </div>
        <button class="btn sm primary" id="addCheckBtn">+ Mục</button>
      </div>
      <div id="checklistList">
        ${(state.checklist || []).filter(c => String(c.status||"").toLowerCase() !== "deleted" && !c.deletedAt)
          .slice()
          .sort((a,b) => Number(a.order||0) - Number(b.order||0) || String(a.text||"").localeCompare(String(b.text||"")))
          .map(c => `
            <div class="list-item" style="${c.done ? "opacity:.55" : ""}">
              <div class="row">
                <label style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;cursor:pointer">
                  <input type="checkbox" data-check-toggle="${escapeHtml(c.id)}" ${c.done ? "checked" : ""} style="width:20px;height:20px;flex-shrink:0">
                  <span style="${c.done ? "text-decoration:line-through" : ""}">${escapeHtml(c.text || "—")}</span>
                </label>
                <button class="btn sm danger" data-check-hide="${escapeHtml(c.id)}">Ẩn</button>
              </div>
            </div>
          `).join("") || '<div class="empty">Chưa có mục. Thêm passport, sim, adapter…</div>'}
      </div>
      <div class="actions" style="margin-top:8px">
        <button class="btn sm" id="seedCheckBtn">+ Gợi ý mặc định</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="row" style="margin-bottom:8px">
        <div>
          <h2>✈️ Booking Vault</h2>
          <div class="small muted">Flight · hotel · reservation</div>
        </div>
        <button class="btn sm primary" id="addBookingBtn">+ Booking</button>
      </div>
      ${bookings.length ? bookings.map(b => `
        <div class="list-item">
          <div class="row">
            <div style="min-width:0">
              <b>${escapeHtml(b.title || "—")}</b>
              <div class="small muted">
                ${escapeHtml(b.type || "")}
                ${b.date ? " · " + escapeHtml(b.date) : ""}
                ${b.time ? " · " + escapeHtml(b.time) : ""}
                ${b.location ? " · " + escapeHtml(b.location) : ""}
              </div>
              ${b.confirmationCode ? `<div class="small muted"># ${escapeHtml(b.confirmationCode)}</div>` : ""}
              ${b.note ? `<div class="small muted">${escapeHtml(b.note)}</div>` : ""}
            </div>
            <div class="actions" style="flex-shrink:0">
              ${b.url ? `<button class="btn sm" onclick="window.open('${escapeHtml(b.url)}','_blank')">Link</button>` : ""}
              <button class="btn sm" data-edit-booking="${escapeHtml(b.id)}">Sửa</button>
              <button class="btn sm danger" data-hide-booking="${escapeHtml(b.id)}">Ẩn</button>
            </div>
          </div>
        </div>
      `).join("") : `<div class="empty">Chưa có booking. Thêm flight, hotel, nhà hàng…</div>`}
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h2>📝 Ghi chú chuyến đi</h2>
        <textarea id="planningNote" placeholder="Ghi chú chung..."></textarea>
        <button id="saveNote" class="btn primary" style="margin-top:8px">Lưu</button>
      </div>
      <div class="card">
        <h2>💾 Backup</h2>
        <p class="muted small">Xuất JSON toàn bộ dữ liệu hiện tại.</p>
        <button id="exportJson" class="btn">Export JSON</button>
      </div>
    </div>

    <div class="card" id="trashPanel" style="margin-top:12px">
      <h2>🗑 Thùng rác</h2><p class="small muted" style="margin:0 0 8px">Khôi phục hoặc <b>Xóa</b> vĩnh viễn (không lấy lại được).</p>
      <h3 class="small muted" style="margin-top:8px">Activities</h3>
      ${deleted.length ? deleted.map(a => `
        <div class="list-item">
          <div class="row">
            <div>
              <b>${escapeHtml(a.title || "—")}</b>
              <div class="small muted">${escapeHtml(a.date || "")} · ${escapeHtml(a.startTime || "")}</div>
            </div>
            <div class="actions">
              <div class="actions">
              <button class="btn sm" data-restore-act="${escapeHtml(a.id)}">↩ Khôi phục</button>
              <button class="btn sm danger" data-purge-act="${escapeHtml(a.id)}">Xóa</button>
            </div>
            </div>
          </div>
        </div>
      `).join("") : `<div class="empty">Không có activity đã ẩn.</div>`}
      <h3 class="small muted" style="margin-top:12px">Chi tiêu</h3>
      ${deletedExp.length ? deletedExp.map(e => `
        <div class="list-item">
          <div class="row">
            <div>
              <b>${escapeHtml(e.description || e.title || "—")}</b>
              <div class="small muted">${escapeHtml(e.date || "")} · ${money(e.amount)}</div>
            </div>
            <div class="actions">
              <div class="actions">
              <button class="btn sm" data-restore-exp="${escapeHtml(e.id)}">↩ Khôi phục</button>
              <button class="btn sm danger" data-purge-exp="${escapeHtml(e.id)}">Xóa</button>
            </div>
              <button class="btn sm danger" data-purge-exp="${escapeHtml(e.id)}">Xóa</button>
            </div>
          </div>
        </div>
      `).join("") : `<div class="empty">Không có khoản chi đã ẩn.</div>`}
      <h3 class="small muted" style="margin-top:12px">Bookings</h3>
      ${deletedBookings.length ? deletedBookings.map(b => `
        <div class="list-item">
          <div class="row">
            <div>
              <b>${escapeHtml(b.title || "—")}</b>
              <div class="small muted">${escapeHtml(b.date || "")}</div>
            </div>
            <div class="actions">
              <div class="actions">
              <button class="btn sm" data-restore-booking="${escapeHtml(b.id)}">↩ Khôi phục</button>
              <button class="btn sm danger" data-purge-booking="${escapeHtml(b.id)}">Xóa</button>
            </div>
            </div>
          </div>
        </div>
      `).join("") : `<div class="empty">Không có booking đã ẩn.</div>`}

      <h3 class="small muted" style="margin-top:12px">Checklist</h3>
      ${(state.checklist||[]).filter(c => String(c.status||"").toLowerCase()==="deleted" || c.deletedAt).map(c => `
        <div class="list-item">
          <div class="row">
            <div><b>${escapeHtml(c.text || "—")}</b></div>
            <div class="actions">
              <button class="btn sm" data-restore-check="${escapeHtml(c.id)}">↩ Khôi phục</button>
              <button class="btn sm danger" data-purge-check="${escapeHtml(c.id)}">Xóa</button>
            </div>
          </div>
        </div>
      `).join("") || '<div class="empty">Không có mục checklist đã ẩn.</div>'}

    </div>
  `;


  element.querySelectorAll("[data-more-tab]").forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.moreTab;
      const target = document.querySelector(`#nav button[data-tab="${tab}"]`);
      if (target) target.click();
    };
  });

  document.getElementById("saveNote").onclick = savePlanningNote;
  document.getElementById("exportJson").onclick = exportJson;
  document.getElementById("addBookingBtn").onclick = () => openBookingForm();

  const addCheckBtn = document.getElementById("addCheckBtn");
  if (addCheckBtn) {
    addCheckBtn.onclick = () => {
      openModal("Thêm mục checklist", `
        <form id="checkForm" class="form">
          <label>Nội dung
            <input name="text" required placeholder="Passport, sạc dự phòng…" autofocus>
          </label>
          <button class="btn primary">Thêm</button>
        </form>
      `);
      document.getElementById("checkForm").onsubmit = async (e) => {
        e.preventDefault();
        const text = new FormData(e.target).get("text");
        try {
          await addDoc(checklistRef, {
            text: String(text).trim(),
            done: false,
            order: (state.checklist || []).length,
            status: "active",
            createdAt: new Date().toISOString(),
            ...audit()
          });
          closeModal();
          showToast("Đã thêm");
        } catch (err) { alert(err.message); }
      };
    };
  }
  const seedCheckBtn = document.getElementById("seedCheckBtn");
  if (seedCheckBtn) {
    seedCheckBtn.onclick = async () => {
      if (!confirm("Thêm các mục gợi ý (passport, sim, adapter…)? Chỉ thêm, không xóa mục hiện có.")) return;
      const defaults = [
        "Passport / CCCD", "Vé máy bay / booking", "Sim / eSIM Hàn", "Tiền mặt KRW / thẻ",
        "Sạc dự phòng", "Adapter / củ sạc", "Thuốc cá nhân", "Tai nghe",
        "Áo ấm / áo mưa", "Discover Seoul Pass", "TMC / T-money", "Xác nhận khách sạn"
      ];
      const existing = new Set((state.checklist || []).map(c => String(c.text || "").toLowerCase()));
      try {
        for (const text of defaults) {
          if (existing.has(text.toLowerCase())) continue;
          await addDoc(checklistRef, {
            text, done: false, order: (state.checklist || []).length,
            status: "active", createdAt: new Date().toISOString(), ...audit()
          });
        }
        showToast("Đã thêm gợi ý");
      } catch (err) { alert(err.message); }
    };
  }
  element.querySelectorAll("[data-check-toggle]").forEach(cb => {
    cb.onchange = async () => {
      const id = cb.getAttribute("data-check-toggle");
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "checklist", id), {
          done: !!cb.checked, ...audit()
        });
      } catch (e) { alert(e.message); }
    };
  });
  element.querySelectorAll("[data-check-hide]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("Ẩn mục này?")) return;
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "checklist", btn.getAttribute("data-check-hide")), {
          status: "deleted", deletedAt: new Date().toISOString(), ...audit()
        });
        showToast("Đã ẩn");
      } catch (e) { alert(e.message); }
    };
  });


  element.querySelectorAll("[data-edit-booking]").forEach(btn => {
    btn.onclick = () => openBookingForm(btn.getAttribute("data-edit-booking"));
  });
  element.querySelectorAll("[data-hide-booking]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("Ẩn booking này?")) return;
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "bookings", btn.getAttribute("data-hide-booking")), {
          status: "deleted", deletedAt: new Date().toISOString(), ...audit()
        });
        showToast("Đã ẩn booking");
      } catch (e) { alert(e.message); }
    };
  });
  element.querySelectorAll("[data-restore-act]").forEach(btn => {
    btn.onclick = () => restoreActivity(btn.getAttribute("data-restore-act"));
  });
  element.querySelectorAll("[data-restore-exp]").forEach(btn => {
    btn.onclick = () => restoreExpense(btn.getAttribute("data-restore-exp"));
  });
  element.querySelectorAll("[data-restore-booking]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "bookings", btn.getAttribute("data-restore-booking")), {
          status: "active", deletedAt: null, ...audit()
        });
        showToast("Đã khôi phục booking");
      } catch (e) { alert(e.message); }
    };
  });
  element.querySelectorAll("[data-purge-act]").forEach(btn => {
    btn.onclick = () => purgeActivity(btn.getAttribute("data-purge-act"));
  });
  element.querySelectorAll("[data-purge-exp]").forEach(btn => {
    btn.onclick = () => purgeExpense(btn.getAttribute("data-purge-exp"));
  });
  element.querySelectorAll("[data-purge-booking]").forEach(btn => {
    btn.onclick = () => purgeBooking(btn.getAttribute("data-purge-booking"));
  });

  element.querySelectorAll("[data-restore-check]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await updateDoc(doc(db, "trips", TRIP_ID, "checklist", btn.getAttribute("data-restore-check")), {
          status: "active", deletedAt: null, ...audit()
        });
        showToast("Đã khôi phục");
      } catch (e) { alert(e.message); }
    };
  });
  element.querySelectorAll("[data-purge-check]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("XÓA VĨNH VIỄN mục checklist?")) return;
      try {
        await deleteDoc(doc(db, "trips", TRIP_ID, "checklist", btn.getAttribute("data-purge-check")));
        showToast("Đã xóa vĩnh viễn");
      } catch (e) { alert(e.message); }
    };
  });
}

function openBookingForm(bookingId = null) {
  const b = bookingId
    ? (state._allBookings || state.bookings || []).find(x => x.id === bookingId)
    : null;
  openModal(b ? "Sửa booking" : "Thêm booking", `
    <form id="bookingForm" class="form">
      <label>Tiêu đề
        <input name="title" required value="${escapeHtml(b?.title || "")}" placeholder="Flight ICN / Hotel Myeongdong…">
      </label>
      <div class="form-grid">
        <label>Loại
          <select name="type">
            ${["flight","hotel","restaurant","attraction","transport","other"].map(t =>
              `<option value="${t}" ${(b?.type || "flight") === t ? "selected" : ""}>${t}</option>`
            ).join("")}
          </select>
        </label>
        <label>Ngày
          <input type="date" name="date" value="${escapeHtml(b?.date || state.selectedDay || "")}">
        </label>
      </div>
      <div class="form-grid">
        <label>Giờ
          <input type="time" name="time" value="${escapeHtml(b?.time || "")}">
        </label>
        <label>Mã xác nhận
          <input name="confirmationCode" value="${escapeHtml(b?.confirmationCode || "")}" placeholder="PNR / booking code">
        </label>
      </div>
      <label>Địa điểm
        <input name="location" value="${escapeHtml(b?.location || "")}" placeholder="Sân bay / khách sạn…">
      </label>
      <label>URL
        <input name="url" type="url" value="${escapeHtml(b?.url || "")}" placeholder="https://…">
      </label>
      <label>Ghi chú
        <textarea name="note">${escapeHtml(b?.note || "")}</textarea>
      </label>
      <button class="btn primary">Lưu</button>
    </form>
  `);
  document.getElementById("bookingForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (b) {
        await updateDoc(doc(db, "trips", TRIP_ID, "bookings", b.id), {
          ...data, status: b.status === "deleted" ? "active" : (b.status || "active"), ...audit()
        });
      } else {
        await addDoc(bookingsRef, {
          ...data, status: "active", createdAt: new Date().toISOString(), ...audit()
        });
      }
      closeModal();
      showToast("Đã lưu booking");
    } catch (err) { alert(err.message); }
  };
}


async function loadPlanningNote() {
  try {
    const snapshot = await import(
      "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"
    ).then(module => module.getDocs(notesRef));

    const note = snapshot.docs.find(d => d.id === "planning");
    if (note) {
      const textarea = document.getElementById("planningNote");
      if (textarea) textarea.value = note.data().text || "";
    }
  } catch (error) {
    console.error(error);
  }
}


async function savePlanningNote() {
  const text = document.getElementById("planningNote").value;
  await setDoc(
    doc(db, "trips", TRIP_ID, "notes", "planning"),
    { text, ...audit() },
    { merge: true }
  );
  showToast("Đã lưu ghi chú");
}


async function exportJson() {
  const data = {
    tripId: TRIP_ID,
    exportedAt: new Date().toISOString(),
    activities: state.activities,
    places: state.places,
    expenses: state.expenses,
    bookings: state._allBookings || state.bookings,
    checklist: state.checklist,
    dsp: state.dsp,
    dspMain: state.dspMain
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "seoul-2026-backup.json";
  link.click();
  URL.revokeObjectURL(url);
}


/* =========================================================
   QUICK ADD (Phase 10 early)
========================================================= */

function openQuickAdd() {
  openModal(
    "Quick Add",
    `
      <div class="quick-sheet">
        <button class="btn" id="qaActivity">📅 Activity</button>
        <button class="btn" id="qaImpact">⚡ Activity + Impact</button>
        <button class="btn" id="qaExpense">💳 Khoản chi</button>
        <button class="btn" id="qaNote">📝 Ghi chú nhanh</button>
      </div>
    `
  );

  document.getElementById("qaActivity").onclick = () => { closeModal(); openActivityForm(); };
  const qaI=document.getElementById("qaImpact"); if(qaI) qaI.onclick=()=>{closeModal();openImpactForm();};
  document.getElementById("qaExpense").onclick = () => {
    closeModal();
    openExpenseForm();
  };
  document.getElementById("qaNote").onclick = () => {
    closeModal();
    openQuickNote();
  };
}


function openQuickNote() {
  openModal(
    "Ghi chú nhanh",
    `
      <form id="quickNoteForm" class="form">
        <label>
          Nội dung
          <textarea name="text" required placeholder="Ghi nhanh..."></textarea>
        </label>
        <button class="btn primary">Lưu vào ghi chú chuyến đi</button>
      </form>
    `
  );

  document.getElementById("quickNoteForm").onsubmit = async event => {
    event.preventDefault();
    const text = new FormData(event.target).get("text");
    const stamp = new Date().toLocaleString("vi-VN", { timeZone: TRIP_TIMEZONE });
    const line = `\n[${stamp}] ${text}`;

    // Append to planning note
    try {
      const { getDoc } = await import(
        "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"
      );
      const ref = doc(db, "trips", TRIP_ID, "notes", "planning");
      const snap = await getDoc(ref);
      const prev = snap.exists() ? (snap.data().text || "") : "";
      await setDoc(ref, { text: prev + line, ...audit() }, { merge: true });
      closeModal();
      showToast("Đã lưu ghi chú");
    } catch (err) {
      alert(err.message);
    }
  };
}


document.getElementById("quickAddFab").onclick = openQuickAdd;


/* =========================================================
   RENDER + NOW TIMER
========================================================= */

function render() {
  if (!state.user) return;

  // Render only the visible surface. This prevents Firestore updates from
  // rebuilding six hidden screens and repeatedly destroying/recreating the map.
  const renderers = {
    dashboard: renderDashboard,
    itinerary: renderItinerary,
    dsp: renderDSP,
    expenses: renderExpenses,
    places: renderPlaces,
    more: renderMore
  };
  const renderer = renderers[state.tab] || renderDashboard;
  renderer();

  if (state.tab !== "itinerary") destroyDayMap();

  const goDsp = document.getElementById("goDspMini");
  if (goDsp) {
    goDsp.onclick = () => {
      state.tab = "dsp";
      document.querySelector('[data-tab="dsp"]').click();
    };
  }
}



/** Cảnh báo 15–30 phút trước activity (ưu tiên fixed). Toast 1 lần / activity / ngưỡng. */
function checkUpcomingAlerts() {
  const now = new Date();
  const todayStr = localDateString(now);
  if (todayStr < TRIP_START || todayStr > TRIP_END) return;
  const nowMin = localTimeMinutes(now);
  const list = (typeof activeActivities === "function" ? activeActivities() : state.activities)
    .filter(a => a.date === todayStr);
  for (const a of list) {
    const st = String(a.status || "").toLowerCase();
    if (st === "done" || st === "skipped" || st === "deleted") continue;
    const start = minutes(a.startTime);
    if (!Number.isFinite(start)) continue;
    const minsUntil = start - nowMin;
    if (minsUntil > 30 || minsUntil < 1) continue;
    const key = todayStr + ":" + a.id + ":" + (minsUntil <= 15 ? "15" : "30");
    if (state.alertedIds[key]) continue;
    state.alertedIds[key] = true;
    const label = minsUntil <= 15 ? ("còn " + minsUntil + " phút") : ("còn ~" + minsUntil + " phút");
    const mode = a.mode === "fixed" ? "🔒 " : "";
    showToast(mode + "Sắp tới: " + (a.title || "Activity") + " (" + label + ")");
    const banner = document.getElementById("upcomingAlertBanner");
    if (banner) {
      banner.className = "status-banner yellow";
      banner.textContent = mode + "Sắp tới · " + (a.title || "Activity") + " · " + label + " · " + (a.startTime || "");
      banner.style.display = "";
    }
  }
}

async function loadDayNote(day) {
  try {
    const { getDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
    const snap = await getDoc(doc(db, "trips", TRIP_ID, "notes", "day-" + day));
    const text = snap.exists() ? (snap.data().text || "") : "";
    state.dayNoteText = text;
    const el = document.getElementById("dayNoteInput");
    if (el && document.activeElement !== el) el.value = text;
  } catch (e) { console.error(e); }
}

function startNowTimer() {
  stopNowTimer();
  nowTimer = setInterval(() => {
    state.nowTick = Date.now();
    try { checkUpcomingAlerts(); } catch (_) {}
    // Only soft-refresh dashboard if visible — avoid full map rebuild
    if (state.tab === "dashboard" && state.user) {
      renderDashboard();
      const goDsp = document.getElementById("goDspMini");
      if (goDsp) {
        goDsp.onclick = () => {
          state.tab = "dsp";
          document.querySelector('[data-tab="dsp"]').click();
        };
      }
    }
  }, 30000);
}


function stopNowTimer() {
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
}


/* =========================================================
   AUTH
========================================================= */

document.getElementById("loginBtn").onclick = async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    const element = document.getElementById("loginError");
    element.textContent = error.message;
    element.classList.remove("hidden");
  }
};


document.getElementById("logoutBtn").onclick = () => signOut(auth);


onAuthStateChanged(auth, user => {
  state.user = user;

  document.getElementById("loginView").classList.toggle("hidden", !!user);
  document.getElementById("appView").classList.toggle("hidden", !user);

  if (!user) {
    state.unsubscribe.forEach(unsub => unsub?.());
    state.unsubscribe = [];
    destroyDayMap();
    stopNowTimer();
    return;
  }

  document.getElementById("userName").textContent =
    user.displayName || user.email || "";

  if (user.photoURL) {
    const avatar = document.getElementById("avatar");
    avatar.src = user.photoURL;
    avatar.classList.remove("hidden");
  }

  subscribeFirestore();
  startNowTimer();
  renderConnectionState();
  render();
});
