# syntax=docker/dockerfile:1.7
# Standalone Docker runtime; no Kubernetes or CI system is required.
# Build on linux/amd64 (Google Chrome's official Linux package is amd64).
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY studio ./studio
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DISPLAY=:99 \
    HOME=/home/node \
    FLOW_MCP_HOME=/data/config \
    FLOW_MCP_OUTPUT=/data/output \
    FLOW_MCP_CHROME=/usr/local/bin/flow-chrome

# Chrome drives the real Flow UI. Xvfb supplies its display, and noVNC
# makes the first interactive Google sign-in possible from another machine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg xvfb x11vnc novnc websockify \
       ffmpeg unzip libglib2.0-bin tini \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/studio ./studio
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Chromium's Linux namespace sandbox is unavailable in many Docker hosts.
# Keep the container unprivileged; do not use --privileged or expose CDP.
RUN printf '%s\n' '#!/bin/sh' \
      'exec /usr/bin/google-chrome --no-sandbox "$@"' \
      > /usr/local/bin/flow-chrome \
    && chmod +x /usr/local/bin/flow-chrome \
    && mkdir -p /data/config /data/output \
    && chown -R node:node /app /data /home/node

# The studio API intentionally remains bound to 127.0.0.1 inside the
# container. Open it in Chrome through noVNC, not through a published port.
# Publish noVNC only on the Docker host's loopback interface, e.g.:
#   docker build -t flow-mcp .
#   docker run -d --name flow-mcp --shm-size=1g \
#     -p 127.0.0.1:6080:6080 -v flow-mcp-data:/data \
#     -e FLOW_VNC_PASSWORD='choose-a-password' flow-mcp
#   (Or pass a secret file with -e FLOW_VNC_PASSWORD_FILE=/run/secrets/vnc_password.)
#   Open http://127.0.0.1:6080/vnc.html in a browser, connect, and sign in
#   to Google in the Chrome window. The Chrome profile persists in /data.
# The VNC protocol only uses the first 8 password characters; use localhost
# binding plus an authenticated HTTPS tunnel for access from another host.
RUN <<'SH'
cat > /usr/local/bin/flow-container-start <<'EOF'
#!/bin/sh
set -eu
if [ -n "${FLOW_VNC_PASSWORD_FILE:-}" ]; then
  if [ ! -r "$FLOW_VNC_PASSWORD_FILE" ]; then
    echo "FLOW_VNC_PASSWORD_FILE is not readable: $FLOW_VNC_PASSWORD_FILE" >&2
    exit 1
  fi
  IFS= read -r FLOW_VNC_PASSWORD < "$FLOW_VNC_PASSWORD_FILE" || true
  FLOW_VNC_PASSWORD="${FLOW_VNC_PASSWORD%$(printf '\r')}"
fi
: "${FLOW_VNC_PASSWORD:?Set FLOW_VNC_PASSWORD or FLOW_VNC_PASSWORD_FILE for interactive login (at least 8 characters)}"
if [ "${#FLOW_VNC_PASSWORD}" -lt 8 ]; then
  echo "VNC password must be at least 8 characters long." >&2
  exit 1
fi
echo "Warning: publish port 6080 on loopback only (-p 127.0.0.1:6080:6080); never expose noVNC directly on a public interface." >&2
mkdir -p /data/config /data/output /tmp/flow-vnc
chmod 700 /tmp/flow-vnc
x11vnc -storepasswd "$FLOW_VNC_PASSWORD" /tmp/flow-vnc/passwd >/dev/null
chmod 600 /tmp/flow-vnc/passwd
unset FLOW_VNC_PASSWORD FLOW_VNC_PASSWORD_FILE
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
xvfb_pid=$!
x_sock="/tmp/.X11-unix/X${DISPLAY#:}"
i=0
while [ ! -S "$x_sock" ] && [ "$i" -lt 50 ]; do
  kill -0 "$xvfb_pid" 2>/dev/null || { echo "Xvfb exited before creating $x_sock" >&2; exit 1; }
  sleep 0.1
  i=$((i + 1))
done
if [ ! -S "$x_sock" ]; then
  echo "Timed out waiting for Xvfb socket $x_sock" >&2
  exit 1
fi
x11vnc -display "$DISPLAY" -rfbauth /tmp/flow-vnc/passwd -rfbport 5900 -localhost -forever -shared -quiet &
vnc_pid=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &
web_pid=$!
cleanup() {
  kill "$web_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
# Opens the dedicated Chrome profile; login remains a manual Google action.
node /app/dist/login.js &
node /app/dist/studio.js &
studio_pid=$!
wait "$studio_pid"
EOF
chmod +x /usr/local/bin/flow-container-start
SH

USER node
VOLUME ["/data"]
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/flow-container-start"]
