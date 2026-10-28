# Publication review — 2026-10-28

Reviewed the publication file set, bridge authentication and input paths, dependency audit, licenses, and demo frames.

- Removed personal owner/origin defaults; explicit configuration is required and missing configuration fails closed.
- Excluded local evidence, raw recordings, private settings, and real session IDs from Git.
- Added MIT license and bundled third-party license notices.
- Added a 32-connection server limit and retained loopback-only binding, request deadlines, fixed CLI arguments, owner/Host/Origin validation, and no terminal-content logs.
- `npm audit` reported zero known vulnerabilities at review time. This is not a guarantee of security.
- Backend, frontend regression, and shipped WASM replay checks passed locally.
- Demo: actual Screen Studio recording of Safari and Rex, cropped to exclude the hostname/menu bar, with audio and metadata stripped. Inspected sampled frames visually and scanned frames with OCR for personal configuration strings.

## Limits

The bridge trusts Tailscale Serve headers; another local process can forge them. Use a trusted Mac, loopback binding and tailnet-only Serve, never Funnel. Any accepted owner can run commands in Rex. Snapshot sync is approximately two seconds and is not an output stream. Browser resizing ownership, mouse reporting and physical iPhone IME/rotation/resume acceptance remain incomplete. The owner subsequently confirmed input and Claude replies on iPhone 15 Pro Max Safari; this is a user-reported device check. The demo only proves Mac Safari behavior. This is an unofficial personal project, not an upstream release.
