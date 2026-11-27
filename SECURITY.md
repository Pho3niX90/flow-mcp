# Security Policy

## Reporting a Vulnerability

Please report security issues privately through GitHub's private vulnerability reporting for this repository:

https://github.com/Pho3niX90/flow-mcp/security/advisories/new

Do not open a public issue for an unpatched vulnerability. Include the commit hash, steps to reproduce, and the expected vs. actual behaviour.

## Threat Model

`flow-mcp` is a single-user local tool that automates Google Flow and Google Flow Music in a dedicated local Chrome window and serves a local control panel on `127.0.0.1`.

### In Scope

- **Web and cross-origin attacks against the local HTTP server:** DNS rebinding, cross-origin requests from other browser tabs, XSS/script injection in the Studio panel, or unauthorized access to `/api/*` and `/media`.
- **Untrusted remote content and files:** malicious asset/project/song names, archive entries (ZIP slips, symlinks), unexpected MIME/file types, untrusted media URLs or redirects, and credit-quote parsing bypasses.
- **Local command, path, and filter injection:** shell/PowerShell quoting issues, FFmpeg filter-graph injection, path traversal or symlink escape out of the output folder, and unverified speech-model downloads.

### Out of Scope

- **Other programs or users on the same computer:** the Studio panel (`GET /`) serves its per-run token to any local client that requests it, and Chrome's remote-debugging port (`--remote-debugging-port`) listens on `127.0.0.1` without authentication. `flow-mcp` is not designed for multi-user or shared machines where untrusted local processes or OS users share loopback access.
- **Tool-approval scoping via `FLOW_MCP_TOOLS`:** `FLOW_MCP_TOOLS` reduces the initial tool list for context efficiency; it is not an authorization boundary because `flow_call` can invoke any tool.
- **Third-party model loaders without digest pinning:** `kokoro-js` downloads its voice model from Hugging Face without a pinned commit or checksum controlled by `flow-mcp`.
