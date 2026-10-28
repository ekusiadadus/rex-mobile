"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    value: "", textContent: "", checked: false, disabled: false, hidden: false,
    style: { setProperty() {} }, scrollTop: 0, scrollLeft: 0, scrollHeight: 100,
    dataset: {}, selectedOptions: [],
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    fire(name) { listeners.get(name)?.({ preventDefault() {} }); },
    replaceChildren(...nodes) { this.children = nodes; this.value = nodes[0]?.value ?? ""; },
    add(node) { this.children.push(node); },
  };
}

async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const ids = ["session", "block", "screen", "screen-scroll", "screen-title", "status", "input-status",
    "live-dot", "refresh", "input-enable", "input-text", "send-text", "send-raw", "input-form",
    "auto-scroll", "font-down", "font-up", "terminal-host"];
  const dom = Object.fromEntries(ids.map((id) => [id, element()]));
  const keys = [element()];
  keys[0].dataset.key = "enter";
  const captures = [];
  const inputs = [];
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fetch = (url, options) => {
    if (url === "/api/sessions") return Promise.resolve(response({ sessions: [{ session_id: "s", label: "S" }] }));
    if (url.startsWith("/api/blocks?")) return Promise.resolve(response({ blocks: [{ block_id: "b", label: "B" }] }));
    const call = { url, options, pending: deferred() };
    if (url.startsWith("/api/terminal?")) captures.push(call);
    else if (url === "/api/input") inputs.push(call);
    else throw new Error(`Unexpected request: ${url}`);
    return call.pending.promise;
  };
  const document = {
    hidden: false,
    getElementById: (id) => dom[id],
    querySelectorAll: () => keys,
    createElement: () => element(),
    addEventListener() {},
  };
  let nextTimer = 0;
  const context = vm.createContext({ document, fetch, URLSearchParams, AbortController,
    window: {RexTerminal: {create: async () => ({snapshot: async (vt) => {dom.screen.textContent=vt;}})}},
    location: { search: "" }, setTimeout: () => ++nextTimer, clearTimeout() {} });
  const app = fs.readFileSync(path.join(__dirname, "static/app.js"), "utf8");
  vm.runInContext(app, context);
  await flush();
  assert.equal(captures.length, 1, "initial capture starts");

  dom["input-enable"].checked = true;
  dom["input-enable"].fire("change");
  dom["input-text"].value = "who are you?\n\n";
  dom["input-text"].fire("input");
  assert.equal(dom["send-text"].disabled, false, "text remains sendable during capture");
  assert.equal(dom["send-raw"].disabled, false, "raw text remains sendable during capture");
  assert.equal(keys[0].disabled, false, "keys remain sendable during capture");
  dom["input-form"].fire("submit");
  assert.equal(inputs.length, 1);
  assert.equal(captures[0].options.signal.aborted, true, "send aborts the old capture");
  assert.deepEqual(JSON.parse(inputs[0].options.body), { session: "s", block: "b", text: "who are you?\n\n", submit: true });
  dom["input-form"].fire("submit");
  assert.equal(inputs.length, 1, "duplicate send is blocked");

  inputs[0].pending.resolve(response({ error: "multiple lines" }, 400));
  await flush();
  assert.match(dom["input-status"].textContent, /送信に失敗.*multiple lines/);
  assert.equal(dom["input-status"].classList.contains("error"), true);
  assert.equal(dom["input-text"].value, "who are you?\n\n", "failed text is retained");

  const refresh = vm.runInContext("pollScreen(true)", context);
  assert.equal(captures.length, 2);
  captures[1].pending.resolve(response({ vt: "new screen", columns:80, rows:24 }));
  await refresh;
  assert.equal(dom.screen.textContent, "new screen");
  assert.match(dom["input-status"].textContent, /送信に失敗/, "refresh preserves input error");

  captures[0].pending.resolve(response({ vt: "stale screen", columns:80, rows:24 }));
  await flush();
  assert.equal(dom.screen.textContent, "new screen", "stale capture cannot overwrite the new view");
  assert.match(dom["input-status"].textContent, /送信に失敗/);

  dom["send-raw"].fire("click");
  assert.equal(inputs.length, 2);
  assert.deepEqual(JSON.parse(inputs[1].options.body), { session: "s", block: "b", text: "who are you?\n\n" }, "raw action omits submit");
  inputs[1].pending.resolve(response({ ok: true }));
  await flush();
  assert.match(dom["input-status"].textContent, /文字を送信しました/);

  const unavailable = vm.runInContext("pollScreen(true)", context);
  assert.equal(captures.length, 3);
  captures[2].pending.resolve(response({ error: "session not found" }, 404));
  await unavailable;
  await flush();
  assert.match(dom.screen.textContent, /接続は維持/);
  assert.match(dom.status.textContent, /Rex に接続中/);
  assert.equal(dom.block.disabled, false, "remaining terminals can be selected");
  assert.equal(dom["live-dot"].classList.contains("on"), true);
  await vm.runInContext("pollAvailableTargets()", context);
  assert.equal(dom.block.value, "", "discovery never switches target automatically");
  assert.equal(dom.block.value, "", "ended target selection is cleared");
  assert.equal(dom["input-enable"].checked, false, "input is disarmed");
  assert.equal(dom["send-text"].disabled, true);
  assert.equal(dom["send-raw"].disabled, true);
  await testMissingUrlSession(app);
  console.log("frontend input and polling regressions: passed");
}

async function testMissingUrlSession(app) {
  const ids = ["session", "block", "screen", "screen-scroll", "screen-title", "status", "input-status",
    "live-dot", "refresh", "input-enable", "input-text", "send-text", "send-raw", "input-form",
    "auto-scroll", "font-down", "font-up", "terminal-host"];
  const dom = Object.fromEntries(ids.map((id) => [id, element()]));
  const calls = [];
  const response = (body) => ({ ok: true, json: async () => body });
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => dom[id], querySelectorAll: () => [],
      createElement: () => element(), addEventListener() {} },
    fetch: (url) => {
      calls.push(url);
      if (url === "/api/sessions") return Promise.resolve(response({ sessions: [{ session_id: "other", label: "Other" }] }));
      if (url.startsWith("/api/blocks?")) return Promise.resolve(response({ blocks: [] }));
      throw new Error(`Unexpected request: ${url}`);
    },
    URLSearchParams, AbortController,
    location: { search: "?session=ended&block=old" },
    setTimeout() {}, clearTimeout() {},
  });
  vm.runInContext(app, context);
  await flush();
  assert.deepEqual(calls, ["/api/sessions"], "missing pinned session never loads another target");
  assert.equal(dom.session.value, "", "session stays unselected");
  assert.equal(dom.block.value, "", "block stays unselected");
  assert.match(dom.screen.textContent, /セッションは終了しました/);
  assert.equal(dom["send-text"].disabled, true);
  dom.session.value = "other";
  dom.session.fire("change");
  await flush();
  assert.equal(calls.length, 2, "explicit session choice loads its blocks");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
