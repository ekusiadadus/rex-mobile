#!/usr/bin/env python3
"""Bounded, disposable Rex terminal stream probe. Creates and removes its own session."""

import json
import subprocess
import time
from pathlib import Path


REX = Path.home() / "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT / "evidence"


def rex(*args):
    return subprocess.check_output([str(REX), "--autostart=false", *args], timeout=15)


def main():
    EVIDENCE.mkdir(exist_ok=True)
    created = json.loads(rex("new", "rex-mobile-transport-probe", "-c", str(ROOT), "--window", "Probe", "--json"))
    session = created["session_id"]
    block = created["initial_windows"][0]["block_ids"][0]
    stream = None
    try:
        stream = subprocess.Popen([str(REX), "--autostart=false", "block", "stream", block, "terminal"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(0.5)
        rex("send", "-s", session, "-b", block, "--", "printf 'REX_STREAM_MARKER_9f2a\\n'")
        rex("send-key", "-s", session, "-b", block, "enter")
        time.sleep(1.0)
        stream.terminate()
        stdout, stderr = stream.communicate(timeout=5)
        (EVIDENCE / "transport-stream.bin").write_bytes(stdout)
        (EVIDENCE / "transport-stream.stderr").write_bytes(stderr)
        result = {"stream_exit": stream.returncode, "stream_bytes": len(stdout), "stream_has_marker": b"REX_STREAM_MARKER_9f2a" in stdout,
                  "stream_prefix_hex": stdout[:32].hex(), "stderr": stderr.decode(errors="replace")[:500]}
        for name, args in {
            "format_vt": ("block", "call", "-s", session, "-b", block, "format", json.dumps({"format": "vt", "extra_cursor": True, "extra_modes": True, "max_bytes": 131072})),
            "size": ("block", "call", "-s", session, "-b", block, "size", "{}"),
            "modes": ("block", "call", "-s", session, "-b", block, "modes", "{}"),
        }.items():
            data = rex(*args)
            (EVIDENCE / f"transport-{name}.json").write_bytes(data)
            result[name + "_bytes"] = len(data)
            if name == "format_vt":
                snapshot = json.loads(data)["content"]
                result["vt_has_escape"] = "\x1b" in snapshot
                result["vt_has_marker"] = "REX_STREAM_MARKER_9f2a" in snapshot
        (EVIDENCE / "transport-summary.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
    finally:
        if stream and stream.poll() is None:
            stream.kill()
            stream.communicate()
        rex("kill", session)


if __name__ == "__main__":
    main()
