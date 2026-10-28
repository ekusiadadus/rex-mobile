import { Ghostty, Terminal } from "ghostty-web";

let initialization;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new RangeError(`${name} must be an integer from 1 to 1000`);
  }
  return value;
}

async function create(container, options = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError("Terminal container must be an HTMLElement");
  initialization ||= Ghostty.load("/static/vendor/ghostty-vt.wasm");
  const ghostty = await initialization;

  const stage = document.createElement("div");
  const surface = document.createElement("div");
  stage.appendChild(surface);
  container.replaceChildren(stage);
  container.style.overflow = "auto";
  container.style.position = "relative";
  stage.style.position = "relative";
  stage.style.transformOrigin = "top left";
  surface.style.position = "absolute";
  surface.style.top = "0";
  surface.style.left = "0";
  surface.style.whiteSpace = "pre";

  const term = new Terminal({
    ghostty,
    cols: 80,
    rows: 24,
    fontSize: options.fontSize ?? 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursorBlink: false,
    theme: { background: "#0c1015", foreground: "#d8e2dc", cursor: "#78e5aa" },
  });
  let onData = options.onData ?? null;
  let inputEnabled = options.inputEnabled === true;
  let applyingSnapshot = false;
  let destroyed = false;
  let lastSnapshot = null;
  let zoom = 1;
  const subscription = term.onData((data) => {
    if (!destroyed && inputEnabled && !applyingSnapshot && onData) onData(data);
  });
  term.open(surface);

  function fit() {
    if (destroyed || !term.canvas) return;
    const canvas = term.canvas;
    const width = parseFloat(canvas.style.width) || canvas.width;
    const height = parseFloat(canvas.style.height) || canvas.height;
    if (!width || !height) return;
    const availableWidth = container.clientWidth;
    const availableHeight = container.clientHeight;
    // The server owns the cell grid. Scale the rendered canvas, never reflow it.
    const scale = Math.min(1, availableWidth / width || 1, availableHeight / height || 1) * zoom;
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    surface.style.transformOrigin = "top left";
    surface.style.transform = `scale(${scale})`;
    stage.style.width = `${Math.ceil(width * scale)}px`;
    stage.style.height = `${Math.ceil(height * scale)}px`;
  }

  const observer = new ResizeObserver(fit);
  observer.observe(container);
  fit();

  return {
    snapshot(vt, cols, rows, settings = {}) {
      if (destroyed) return;
      if (typeof vt !== "string") throw new TypeError("VT snapshot must be a string");
      positiveInteger(cols, "columns");
      positiveInteger(rows, "rows");
      if (lastSnapshot?.vt === vt && lastSnapshot.cols === cols && lastSnapshot.rows === rows) { fit(); return; }
      const viewport = settings.autoScroll === false ? term.viewportY : 0;
      applyingSnapshot = true;
      try {
        if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
        term.clearSelection();
        term.reset();
        // ghostty-web 0.4.0's reset replaces wasmTerm but leaves the selection
        // manager pointing at the freed one. Keep it on the current buffer.
        if (term.selectionManager) term.selectionManager.wasmTerm = term.wasmTerm;
        // The freshly allocated WASM cell buffer can contain stale bytes from
        // the freed one until the screen is explicitly erased.
        term.write("\x1b[2J\x1b[H" + vt);
        term.scrollToBottom();
        if (viewport) term.viewportY = Math.min(viewport, term.getScrollbackLength());
        // A complete snapshot needs a full canvas draw even if the WASM dirty
        // markers were consumed while resetting the terminal.
        term.renderer.render(term.wasmTerm, true, term.viewportY, term);
        lastSnapshot = {vt, cols, rows};
        fit();
      } finally {
        applyingSnapshot = false;
      }
    },
    setOnData(callback) {
      if (callback != null && typeof callback !== "function") throw new TypeError("onData must be a function or null");
      onData = callback;
    },
    setInputEnabled(enabled) { inputEnabled = enabled === true; },
    setFontSize(size) {
      if (!Number.isFinite(size) || size < 6 || size > 48) throw new RangeError("font size must be 6 to 48 px");
      zoom = size / (options.fontSize ?? 13);
      fit();
    },
    focus() { if (!destroyed) term.focus(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      subscription.dispose();
      term.dispose();
      container.replaceChildren();
    },
  };
}

window.RexTerminal = { create };
