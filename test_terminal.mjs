import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { Ghostty } from "ghostty-web";

const wasm = await readFile(new URL("./static/vendor/ghostty-vt.wasm", import.meta.url));
assert.ok(WebAssembly.validate(wasm), "shipped Ghostty WASM is valid");
// Node cannot fetch file: URLs, so load the exact shipped bytes through data:.
const ghostty = await Ghostty.load(`data:application/wasm;base64,${wasm.toString("base64")}`);

function visibleLine(terminal, row) {
  terminal.update();
  return terminal.getLine(row).map((cell) => String.fromCodePoint(cell.codepoint || 32)).join("").trimEnd();
}

let terminal = ghostty.createTerminal(10, 3);
terminal.write("one\r\ntwo\r\nthree\r\nfour");
assert.equal(terminal.getScrollbackLength(), 1);
assert.equal(visibleLine(terminal, 2), "four");
terminal.free();

terminal = ghostty.createTerminal(12, 4);
assert.equal(terminal.getScrollbackLength(), 0, "a replacement snapshot has no previous scrollback");
terminal.write("\x1b[2J\x1b[H\x1b[38;2;255;0;0mRED_TEXT\x1b[0m");
assert.equal(visibleLine(terminal, 0), "RED_TEXT");
assert.deepEqual([terminal.getLine(0)[0].fg_r, terminal.getLine(0)[0].fg_g, terminal.getLine(0)[0].fg_b], [255, 0, 0]);
terminal.resize(86, 54);
assert.deepEqual(terminal.getDimensions(), { cols: 86, rows: 54 });
terminal.free();

// Rex VT captures can contain a populated final row. Removing the last row
// separator would move that content up, in normal and alternate screen modes.
for (const alternate of [false, true]) {
  terminal = ghostty.createTerminal(80, 24);
  terminal.write("\x1b[2J\x1b[H" + (alternate ? "\x1b[?1049h" : "") +
    "TOP" + "\r\n".repeat(23) + "ROW_BOTTOM" + "\x1b[1;1H");
  assert.equal(visibleLine(terminal, 23), "ROW_BOTTOM");
  assert.equal(visibleLine(terminal, 22), "");
  terminal.free();
}

// Replay captured Rex snapshots when the local evidence files are present.
// These catch the original full-screen scroll and colored-text cases.
for (const name of ["live-vt.json", "live-color-vt.json"]) {
  const url = new URL(`./evidence/${name}`, import.meta.url);
  try { await access(url); } catch { continue; }
  const snapshot = JSON.parse(await readFile(url, "utf8"));
  terminal = ghostty.createTerminal(snapshot.columns, snapshot.rows);
  terminal.write(snapshot.vt);
  const visible = Array.from({ length: snapshot.rows }, (_, row) => visibleLine(terminal, row)).join("\n");
  assert.ok(visible.trim(), `${name} must render visible text`);
  assert.ok(terminal.getCursor().x < snapshot.columns);
  terminal.free();
  console.log(`PASS: replayed ${name}`);
}
console.log("PASS: shipped Ghostty WASM validates, resets state, renders ANSI color, and keeps exact dimensions");
