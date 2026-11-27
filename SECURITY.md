# Security

## Reporting a problem

Please report security problems privately, through GitHub's private vulnerability reporting for this repository:

https://github.com/Pho3niX90/flow-mcp/security/advisories/new

Do not open a public issue for a problem that is not fixed yet. Say which commit you tested, how to reproduce it,
and what you expected to happen.

## What flow-mcp protects against

flow-mcp is a tool for one person on their own computer. It drives Google Flow and Flow Music in a dedicated Chrome
window and serves a control panel on `127.0.0.1`.

These are treated as security problems:

- **A website reaching the local service:** DNS rebinding, requests from another site, framing the panel, script
  injection in the panel, or any way to use `/api/*` or `/media` without the token.
- **Content from Flow, Flow Music or a file you were sent doing harm:** names or titles that end up in a command,
  a file path or an ffmpeg filter; archives with links or paths that leave their folder; files that are not what
  their name says; addresses that lead a download somewhere else; a credit limit that can be got around.
- **Files written or removed outside the output folder,** and models fetched without being checked.

## What it does not protect against

- **Other programs and other people on the same computer.** The panel page gives its token to any local program
  that asks, and Chrome's remote-control port has no password. flow-mcp is not meant for a shared computer.
- **An assistant that has been told to use every tool.** `FLOW_MCP_TOOLS` chooses which tools are listed, not which
  are allowed; `flow_call` can run any of them.
- **The Kokoro voice model,** which its own library fetches from Hugging Face without a fixed version or a checksum.
