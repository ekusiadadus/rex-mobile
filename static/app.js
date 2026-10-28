"use strict";

const $ = (id) => document.getElementById(id);
const ui = {
  session: $("session"), block: $("block"), screen: $("screen"), scroll: $("screen-scroll"),
  title: $("screen-title"), status: $("status"), inputStatus: $("input-status"), dot: $("live-dot"), refresh: $("refresh"),
  enabled: $("input-enable"), text: $("input-text"), send: $("send-text"), raw: $("send-raw"), form: $("input-form"),
  autoScroll: $("auto-scroll"), fontDown: $("font-down"), fontUp: $("font-up"),
  keys: [...document.querySelectorAll("[data-key]")],
};

let generation = 0;
let controller = null;
let timer = null;
let pollEpoch = 0;
let loading = false;
let sending = false;
let fontSize = 13;
let selectedBlockLabel = "";
let terminal = null;
let terminalReady = null;
let inputQueue = Promise.resolve();
async function getTerminal() {
  if (!terminalReady) terminalReady = window.RexTerminal.create($("terminal-host"), {
    fontSize,
    onData(data) {
      // Preserve user input order and never retry uncertain terminal writes.
      if (!ui.enabled.checked || !ui.block.value) return;
      const serial = generation;
      inputQueue = inputQueue.then(async () => {
        if (serial === generation && ui.enabled.checked) await sendInput({terminal_data: data});
      });
    },
  }).then((value) => { terminal = value; return value; }).catch((error) => { terminalReady = null; throw error; });
  return terminalReady;
}
const urlTarget = new URLSearchParams(location.search);
const requestedSession = urlTarget.get("session") || "";
const requestedBlock = urlTarget.get("block") || "";
let useRequestedBlock = !!requestedBlock;

function setStatus(message, error = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle("error", error);
  ui.dot.classList.toggle("error", error);
  if (error) ui.dot.classList.remove("on");
}

function setInputStatus(message, error = false) {
  ui.inputStatus.textContent = message;
  ui.inputStatus.classList.toggle("error", error);
}

function updateInput() {
  const editable = !!(ui.session.value && ui.block.value && ui.enabled.checked && !sending);
  const canSend = editable;
  ui.text.disabled = !editable;
  terminal?.setInputEnabled?.(!!(ui.session.value && ui.block.value && ui.enabled.checked));
  ui.send.disabled = !canSend || !ui.text.value;
  ui.raw.disabled = !canSend || !ui.text.value;
  for (const button of ui.keys) button.disabled = !canSend;
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function suffix(id) {
  return typeof id === "string" && id ? id.slice(-6) : "------";
}

function blockLabel(item, index) {
  return `${index + 1}. ${item.label || "端末"} · ${suffix(item.block_id)} · 窓 ${suffix(item.window_id)}`;
}

function resetScreen(message) {
  ui.screen.textContent = message;
  ui.screen.hidden = false;
  if ($("terminal-host")) $("terminal-host").hidden = true;
  ui.scroll.scrollTop = 0;
  ui.scroll.scrollLeft = 0;
  ui.dot.classList.remove("on", "error");
  ui.title.textContent = selectedBlockLabel || "画面";
}

function stopPoll() {
  pollEpoch += 1;
  clearTimeout(timer);
  timer = null;
  controller?.abort();
  controller = null;
}

function targetChanged(message = "画面を読み込み中…") {
  generation += 1;
  stopPoll();
  loading = false;
  ui.enabled.checked = false;
  ui.text.value = "";
  setInputStatus("");
  resetScreen(message);
  updateInput();
  return generation;
}

function targetUnavailable() {
  ui.block.value = "";
  ui.block.disabled = true;
  selectedBlockLabel = "";
  targetChanged("表示していた端末は終了しました。Rex への接続を確認中…");
  void pollAvailableTargets();
}

async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...options });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (typeof body.error === "string") detail = `: ${body.error}`;
    } catch { /* Server may return plain text. */ }
    const error = new Error(`HTTP ${response.status}${detail}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function schedulePoll(delay = 2000) {
  clearTimeout(timer);
  if (document.hidden) return;
  timer = setTimeout(() => {
    if (ui.session.value && ui.block.value) void pollScreen();
    else void pollAvailableTargets();
  }, delay);
}

// Keep the host connection and target discovery alive without a terminal.
async function pollAvailableTargets() {
  if (document.hidden || ui.block.value) return;
  const serial = generation;
  const session = ui.session.value;
  try {
    const data = await request("/api/sessions");
    if (serial !== generation) return;
    if (!Array.isArray(data.sessions)) throw new Error("セッション一覧の形式が正しくありません");
    const sessions = data.sessions.filter((item) => typeof item.session_id === "string");
    ui.session.replaceChildren(option("", "セッションを選択"));
    sessions.forEach((item) => ui.session.add(option(item.session_id, item.label || item.session_id)));
    ui.session.disabled = !sessions.length;
    ui.session.value = sessions.some((item) => item.session_id === session) ? session : "";
    ui.block.replaceChildren(option("", "端末を選択"));
    ui.block.disabled = true;
    if (ui.session.value) {
      const result = await request(`/api/blocks?${new URLSearchParams({ session })}`);
      if (serial !== generation) return;
      if (!Array.isArray(result.blocks)) throw new Error("端末一覧の形式が正しくありません");
      result.blocks.forEach((item, index) => ui.block.add(option(item.block_id, blockLabel(item, index))));
      ui.block.disabled = !result.blocks.length;
    }
    resetScreen("表示する端末がありません。接続は維持されています。セッション・端末を選択してください。");
    setStatus("Rex に接続中 · 端末一覧を自動更新しています");
    ui.dot.classList.add("on");
  } catch (error) {
    if (serial !== generation) return;
    setStatus(error.status === 404 ? "端末一覧を更新中…" : `Rex に接続できません · 自動再接続中: ${error.message}`, error.status !== 404);
  } finally {
    if (serial === generation) { updateInput(); schedulePoll(); }
  }
}

async function pollScreen(force = false) {
  if ((!force && document.hidden) || !ui.session.value || !ui.block.value || sending || loading) return;
  const serial = generation;
  const session = ui.session.value;
  const block = ui.block.value;
  const epoch = ++pollEpoch;
  controller = new AbortController();
  loading = true;
  updateInput();
  try {
    const params = new URLSearchParams({ session, block });
    const data = await request(`/api/terminal?${params}`, { signal: controller.signal });
    if (serial !== generation || epoch !== pollEpoch || session !== ui.session.value || block !== ui.block.value) return;
    if (typeof data.vt !== "string") throw new Error("端末データの形式が正しくありません");
    const renderer = await getTerminal();
    if (serial !== generation || epoch !== pollEpoch) return;
    $("terminal-host").hidden = false;
    await renderer.snapshot(data.vt, data.columns, data.rows, {autoScroll: ui.autoScroll.checked});
    if (serial !== generation || epoch !== pollEpoch) return;
    ui.screen.hidden = true;
    ui.dot.classList.add("on");
    setStatus("接続中 · WASM 端末 · 画面を定期同期");
    if (ui.autoScroll.checked) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  } catch (error) {
    if (serial !== generation || epoch !== pollEpoch || error.name === "AbortError") return;
    if (error.status === 404) { targetUnavailable(); return; }
    ui.dot.classList.remove("on");
    setStatus(`画面の取得に失敗: ${error.message}`, true);
  } finally {
    if (serial === generation && epoch === pollEpoch) {
      loading = false;
      controller = null;
      updateInput();
      schedulePoll();
    }
  }
}

async function loadBlocks(serial) {
  const session = ui.session.value;
  ui.block.replaceChildren(option("", "読み込み中…"));
  ui.block.disabled = true;
  selectedBlockLabel = "";
  resetScreen(session ? "端末を読み込み中…" : "セッションを選択してください。");
  if (!session) { setStatus("セッションを選択してください"); return; }
  try {
    const data = await request(`/api/blocks?${new URLSearchParams({ session })}`);
    if (serial !== generation || session !== ui.session.value) return;
    if (!Array.isArray(data.blocks)) throw new Error("端末一覧の形式が正しくありません");
    const blocks = data.blocks.filter((item) => typeof item.block_id === "string");
    ui.block.replaceChildren(option("", blocks.length ? "端末を選択" : "端末がありません"));
    blocks.forEach((item, index) => ui.block.add(option(item.block_id, blockLabel(item, index))));
    ui.block.disabled = !blocks.length;
    if (blocks.length) {
      const requested = useRequestedBlock && session === requestedSession ? requestedBlock : "";
      const index = requested ? blocks.findIndex((item) => item.block_id === requested) : 0;
      if (index < 0) {
        resetScreen("指定された端末は終了しました。端末を選び直してください。");
        setStatus("指定された端末は終了しました。", true);
        return;
      }
      ui.block.value = blocks[index].block_id;
      selectedBlockLabel = blockLabel(blocks[index], index);
      resetScreen("画面を読み込み中…");
      await pollScreen(true);
    } else { setStatus("このセッションに端末がありません"); }
  } catch (error) {
    if (serial !== generation) return;
    ui.block.replaceChildren(option("", "取得できませんでした"));
    setStatus(`端末一覧の取得に失敗: ${error.message}`, true);
    resetScreen("端末を読み込めませんでした。更新してください。");
  } finally { if (serial === generation) { updateInput(); if (!ui.block.value) schedulePoll(); } }
}

async function loadSessions() {
  const serial = targetChanged("セッションを読み込み中…");
  const previous = ui.session.value || requestedSession;
  ui.session.disabled = true;
  ui.block.disabled = true;
  setStatus("セッションを読み込み中…");
  try {
    const data = await request("/api/sessions");
    if (serial !== generation) return;
    if (!Array.isArray(data.sessions)) throw new Error("セッション一覧の形式が正しくありません");
    const sessions = data.sessions.filter((item) => typeof item.session_id === "string");
    ui.session.replaceChildren(option("", sessions.length ? "セッションを選択" : "セッションがありません"));
    sessions.forEach((item) => ui.session.add(option(item.session_id, item.label || item.session_id)));
    ui.session.disabled = !sessions.length;
    if (sessions.length) {
      if (previous && !sessions.some((item) => item.session_id === previous)) {
        ui.block.replaceChildren(option("", "セッションを選択してください"));
        resetScreen("指定されたセッションは終了しました。セッションを選び直してください。");
        setStatus("指定されたセッションは終了しました。", true);
        return;
      }
      ui.session.value = previous || sessions[0].session_id;
      await loadBlocks(serial);
    } else { resetScreen("Mac に実行中のセッションがありません。"); setStatus("セッションがありません"); }
  } catch (error) {
    if (serial !== generation) return;
    ui.session.replaceChildren(option("", "取得できませんでした"));
    setStatus(`セッション一覧の取得に失敗: ${error.message}`, true);
    resetScreen("接続できませんでした。更新してください。");
  } finally { if (serial === generation) { updateInput(); if (!ui.block.value) schedulePoll(); } }
}

async function sendInput(payload) {
  if (!ui.enabled.checked || !ui.session.value || !ui.block.value || sending) return;
  const serial = generation;
  const session = ui.session.value;
  const block = ui.block.value;
  sending = true;
  stopPoll();
  loading = false;
  updateInput();
  setInputStatus("送信中…");
  try {
    await request("/api/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, block, ...payload }),
    });
    if (serial !== generation) return;
    if (Object.hasOwn(payload, "text")) ui.text.value = "";
    setInputStatus(payload.submit ? "送信して Enter を押しました" : Object.hasOwn(payload, "text") ? "文字を送信しました · 実行するには Enter" : "キーを送信しました");
  } catch (error) {
    if (serial !== generation) return;
    if (error.status === 404) { targetUnavailable(); return; }
    setInputStatus(`送信に失敗: ${error.message}`, true);
  } finally {
    sending = false;
    updateInput();
    schedulePoll(200);
  }
}

ui.session.addEventListener("change", () => { useRequestedBlock = false; const serial = targetChanged(); void loadBlocks(serial); });
ui.block.addEventListener("change", () => {
  useRequestedBlock = false;
  const serial = targetChanged(ui.block.value ? "画面を読み込み中…" : "端末を選択してください。");
  selectedBlockLabel = ui.block.selectedOptions[0]?.textContent || "";
  ui.title.textContent = selectedBlockLabel || "画面";
  if (ui.block.value && serial === generation) void pollScreen(true);
});
ui.refresh.addEventListener("click", () => { void loadSessions(); });
ui.enabled.addEventListener("change", updateInput);
ui.text.addEventListener("input", updateInput);
ui.form.addEventListener("submit", (event) => { event.preventDefault(); if (ui.text.value) void sendInput({ text: ui.text.value, submit: true }); });
ui.raw.addEventListener("click", () => { if (ui.text.value) void sendInput({ text: ui.text.value }); });
for (const button of ui.keys) button.addEventListener("click", () => { void sendInput({ key: button.dataset.key }); });
ui.fontDown.addEventListener("click", () => { fontSize = Math.max(10, fontSize - 1); terminal?.setFontSize?.(fontSize); });
ui.fontUp.addEventListener("click", () => { fontSize = Math.min(22, fontSize + 1); terminal?.setFontSize?.(fontSize); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopPoll(); loading = false; updateInput(); }
  else schedulePoll(0);
});

void loadSessions();
