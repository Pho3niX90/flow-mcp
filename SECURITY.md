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

## Why Chrome's control port and the panel token stay as they are

Both were looked at again on 27 November 2026 and left alone on purpose.

- **Chrome's control port.** Chrome can be driven over a private pipe instead of a port, which no other program
  could reach. We tested it on Chrome 158: started that way, Chrome tells every page that it is being automated
  (`navigator.webdriver` is true), and the same happens with a port Chrome picks for itself. Only a fixed port
  leaves it behaving like an ordinary browser, which is what Google's sign-in expects. Hiding that signal would
  mean disguising automation from the site, and this project will not do that.
- **The panel token.** Keeping the token out of the page would stop a local program from using the panel's API,
  but not from using Chrome's port, which gives it more: the whole signed-in session, and through it the files
  the token protects. It would also cost the plain address, bookmarks, and a reopen from the launcher after
  every restart.

This will be looked at again if Chrome offers a private way to attach that does not mark the browser as
automated, or if the panel is ever meant to be reached from another computer.
