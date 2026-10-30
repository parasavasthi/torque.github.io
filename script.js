/* ==========================================================
   Torque A: temporary test controller (talks to a real robot)

   Nothing here is simulated: the page only shows "Connected"
   after the robot's /status endpoint has actually replied, and
   every failed request is reported with its real error.

   Endpoints used (ESP8266 firmware):
     /move?move=F|B|L|R|S     /speed?value=0..1023     /status

   SAFETY MODEL
    - A direction is only sent while its button/key is held.
    - While held, the command is re-sent every HEARTBEAT_MS,
      because the firmware stops the robot if commands stop
      arriving (its watchdog is 600 ms; keep the heartbeat
      well below that).
    - Release, STOP, window blur, tab hidden, page close, or any
      lost connection all trigger a STOP.
    - The firmware watchdog is the final backstop if a STOP
      request itself cannot get through.
   ========================================================== */
"use strict";

const CONFIG = {
  DEFAULT_IP: "192.168.4.1",
  ROBOT_NAME: "Torque A",       // /status must report this name
  HEARTBEAT_MS: 250,            // resend interval while a direction is held
  MOVE_TIMEOUT_MS: 1500,
  STOP_TIMEOUT_MS: 800,
  CONNECT_TIMEOUT_MS: 3000,
  POLL_MS: 2000,                // idle connection check via /status
  POLL_TIMEOUT_MS: 2000,
  POLL_FAILS_ALLOWED: 2,        // consecutive failed polls before "Disconnected"
  STOP_RETRIES: 2,              // extra attempts if a STOP request fails
  SPEED_DEBOUNCE_MS: 150,
};

/* ---------- Elements ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  form: $("connectForm"),
  ip: $("ip"),
  password: $("password"),
  togglePw: $("togglePw"),
  connectBtn: $("connectBtn"),
  status: $("status"),
  statusText: $("statusText"),
  message: $("message"),
  pad: $("pad"),
  stopBtn: $("stopBtn"),
  speed: $("speed"),
  speedValue: $("speedValue"),
};
const dirButtons = Array.from(el.pad.querySelectorAll("[data-move]"));

/* ---------- State ---------- */
let baseUrl = null;        // e.g. "http://192.168.4.1" (null while disconnected)
let connected = false;
let busy = false;          // a connect attempt is in progress
let activeSource = null;   // who holds movement: "ptr:<id>" or "key:<key>"; null = nobody
let activeMove = "S";
let heartbeat = null;
let moveInFlight = false;
let speedTimer = null;
let pollTimer = null;
let pollFails = 0;
let pollBusy = false;

/* ==========================================================
   UI helpers
   ========================================================== */
function showMessage(text, isError = false) {
  el.message.textContent = text;
  el.message.classList.toggle("error", isError);
}

function renderConnectButton() {
  el.connectBtn.textContent = busy ? "Connecting…" : connected ? "Disconnect" : "Connect";
  el.connectBtn.disabled = busy;
}

function setConnected(state) {
  connected = state;
  el.status.dataset.state = state ? "connected" : "disconnected";
  el.statusText.textContent = state ? "Connected" : "Disconnected";
  el.ip.disabled = state;                 // edit the IP while disconnected
  dirButtons.forEach((b) => (b.disabled = !state));
  el.stopBtn.disabled = !state;
  el.speed.disabled = !state;
  renderConnectButton();
}

function setBusy(state) {
  busy = state;
  renderConnectButton();
}

function highlight(cmd) {
  dirButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.move === cmd));
}

/* ==========================================================
   Networking
   ========================================================== */
function fail(kind, message) {
  const e = new Error(message);
  e.kind = kind;            // "timeout" | "network" | "http"
  return e;
}

function hostLabel() {
  return baseUrl ? baseUrl.replace("http://", "") : "the robot";
}

function networkMessage() {
  if (location.protocol === "https:") {
    return "Request blocked: this page is loaded over HTTPS, and browsers refuse to call a plain-HTTP robot from it. Open the page from a local file or an http:// address.";
  }
  return `Could not reach ${hostLabel()}. Check that this device is joined to the Torque_A Wi-Fi, the IP address is correct, and the robot is powered.`;
}

/** GET a robot endpoint. Resolves with parsed JSON (or null); rejects with a real error. */
async function request(path, timeoutMs, extra = {}) {
  if (!baseUrl) throw fail("network", "Not connected.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(baseUrl + path, { signal: ctrl.signal, cache: "no-store", ...extra });
  } catch (err) {
    if (err.name === "AbortError") {
      throw fail("timeout", `No reply from ${hostLabel()} within ${timeoutMs / 1000} s.`);
    }
    throw fail("network", networkMessage());
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch (_) { /* body is optional */ }
  if (!res.ok) {
    const detail = data && data.error ? `: ${data.error}` : "";
    throw fail("http", `Robot rejected the request (HTTP ${res.status}${detail}).`);
  }
  return data;
}

/** Accept "192.168.4.1", "http://192.168.4.1/", "robot.local:80". Returns null if invalid. */
function normalizeHost(input) {
  let h = input.trim().replace(/^https?:\/\//i, "");
  h = h.split("/")[0];
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(h) ? h : null;
}

/* ==========================================================
   Connect / disconnect
   ========================================================== */
async function connect() {
  const host = normalizeHost(el.ip.value);
  if (!host) {
    showMessage("Enter a valid IP address, for example 192.168.4.1.", true);
    return;
  }
  el.ip.value = host;
  setBusy(true);
  showMessage(`Connecting to ${host}…`);
  baseUrl = `http://${host}`;

  try {
    const status = await request("/status", CONFIG.CONNECT_TIMEOUT_MS);
    if (!status || status.robot !== CONFIG.ROBOT_NAME) {
      throw fail("http", `${host} replied, but it does not look like the ${CONFIG.ROBOT_NAME} firmware.`);
    }
    setConnected(true);
    showMessage("");
    try { localStorage.setItem("torqueA.ip", host); } catch (_) { /* storage may be blocked */ }
    startPolling();
    sendSpeedNow();   // make the robot match the slider
  } catch (err) {
    baseUrl = null;
    setConnected(false);
    showMessage(err.message, true);
  } finally {
    setBusy(false);
  }
}

async function disconnect() {
  clearHold();
  await sendStopReliable();     // best effort before dropping the link
  stopPolling();
  baseUrl = null;
  setConnected(false);
  showMessage("Disconnected.");
}

/** The link failed: stop everything, report the real reason. */
function handleLinkLost(message) {
  clearHold();
  stopPolling();
  if (baseUrl) {            // one last best-effort STOP (probably cannot get through)
    fetch(`${baseUrl}/move?move=S`, { keepalive: true, cache: "no-store" }).catch(() => {});
  }
  baseUrl = null;
  setConnected(false);
  showMessage(message, true);
}

function handleRequestError(err) {
  if (err.kind === "http") showMessage(err.message, true);   // robot answered; link is fine
  else handleLinkLost(err.message);                           // no answer; treat as lost
}

/* ---------- Idle connection check ---------- */
function startPolling() {
  stopPolling();
  pollFails = 0;
  pollTimer = setInterval(pollStatus, CONFIG.POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
async function pollStatus() {
  // While moving, the heartbeat already proves the link; skip extra traffic.
  if (!connected || activeSource !== null || pollBusy) return;
  pollBusy = true;
  try {
    await request("/status", CONFIG.POLL_TIMEOUT_MS);
    pollFails = 0;
  } catch (err) {
    if (++pollFails >= CONFIG.POLL_FAILS_ALLOWED) {
      handleLinkLost(`Lost connection to the robot. ${err.message}`);
    }
  } finally {
    pollBusy = false;
  }
}

/* ==========================================================
   Movement
   ========================================================== */

/** Forget the held direction locally (does not send anything). */
function clearHold() {
  clearInterval(heartbeat);
  heartbeat = null;
  activeSource = null;
  activeMove = "S";
  highlight(null);
}

async function sendMove(cmd) {
  moveInFlight = true;
  try {
    await request(`/move?move=${cmd}`, CONFIG.MOVE_TIMEOUT_MS);
  } catch (err) {
    if (activeSource !== null && activeMove === cmd) handleRequestError(err);
  } finally {
    moveInFlight = false;
  }
}

/** Start moving. Ignored if another input already holds movement (no conflicting commands). */
function beginMove(cmd, source) {
  if (!connected || activeSource !== null) return false;
  activeSource = source;
  activeMove = cmd;
  highlight(cmd);
  sendMove(cmd);
  heartbeat = setInterval(() => {
    if (!moveInFlight) sendMove(cmd);   // don't pile up requests on a slow link
  }, CONFIG.HEARTBEAT_MS);
  return true;
}

/** STOP with retries. Resolves true once the robot acknowledged it. */
async function sendStopReliable() {
  for (let i = 0; i <= CONFIG.STOP_RETRIES; i++) {
    try {
      await request("/move?move=S", CONFIG.STOP_TIMEOUT_MS);
      return true;
    } catch (_) { /* retry */ }
  }
  return false;
}

/** Stop now, no matter who is holding movement. */
async function stopNow() {
  if (!connected) return;
  clearHold();
  if (!(await sendStopReliable())) {
    handleLinkLost("STOP was not acknowledged by the robot. Its built-in timeout should halt it shortly.");
  }
}

/** The input that started the movement was released. */
function endMove(source) {
  if (activeSource === source) stopNow();
}

/* ---------- Press and hold (touch, mouse, pen) ---------- */
dirButtons.forEach((btn) => {
  const cmd = btn.dataset.move;

  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);   // keep getting events if the finger slides off
    beginMove(cmd, `ptr:${e.pointerId}`);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
    btn.addEventListener(type, (e) => endMove(`ptr:${e.pointerId}`))
  );
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
});

el.stopBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  stopNow();
});

/* ---------- Keyboard ---------- */
const KEY_MAP = {
  arrowup: "F", w: "F",
  arrowdown: "B", s: "B",
  arrowleft: "L", a: "L",
  arrowright: "R", d: "R",
};

function typingInField(e) {
  const t = e.target;
  return t instanceof HTMLInputElement && (t.type === "text" || t.type === "password");
}

window.addEventListener("keydown", (e) => {
  if (typingInField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();

  if (e.key === " ") {                 // Space = STOP
    e.preventDefault();
    stopNow();
    return;
  }
  const cmd = KEY_MAP[key];
  if (!cmd) return;
  e.preventDefault();                  // also stops arrows from nudging the slider
  if (e.repeat) return;
  beginMove(cmd, `key:${key}`);
});

window.addEventListener("keyup", (e) => {
  if (e.key === " ") { e.preventDefault(); return; }   // avoid "click" on a focused button
  endMove(`key:${e.key.toLowerCase()}`);
});

/* ==========================================================
   Safe stop when the page loses focus or is closed.
   fetch with keepalive lets the request outlive the page.
   ========================================================== */
function stopOnLeave() {
  clearHold();
  if (!connected || !baseUrl) return;
  fetch(`${baseUrl}/move?move=S`, { keepalive: true, cache: "no-store" }).catch(() => {});
}
window.addEventListener("blur", stopOnLeave);
window.addEventListener("pagehide", stopOnLeave);
window.addEventListener("beforeunload", stopOnLeave);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopOnLeave();
});

/* ==========================================================
   Speed slider
   ========================================================== */
async function sendSpeedNow() {
  if (!connected) return;
  try {
    await request(`/speed?value=${el.speed.value}`, CONFIG.MOVE_TIMEOUT_MS);
  } catch (err) {
    handleRequestError(err);
  }
}

el.speed.addEventListener("input", () => {
  el.speedValue.textContent = el.speed.value;       // immediate display update
  clearTimeout(speedTimer);                         // debounce network updates
  speedTimer = setTimeout(sendSpeedNow, CONFIG.SPEED_DEBOUNCE_MS);
});

/* ==========================================================
   Connection form and startup
   ========================================================== */
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return;
  connected ? disconnect() : connect();
});

// The password field is not used by the firmware and is never sent or stored.
el.togglePw.addEventListener("click", () => {
  const show = el.password.type === "password";
  el.password.type = show ? "text" : "password";
  el.togglePw.textContent = show ? "Hide" : "Show";
  el.togglePw.setAttribute("aria-pressed", String(show));
});

(function init() {
  let saved = null;
  try { saved = localStorage.getItem("torqueA.ip"); } catch (_) { /* ignore */ }
  el.ip.value = saved || CONFIG.DEFAULT_IP;
  el.speedValue.textContent = el.speed.value;
  setConnected(false);
})();
