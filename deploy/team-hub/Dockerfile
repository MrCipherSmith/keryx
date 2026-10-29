FROM oven/bun:1.3.14-debian
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/* && mkdir -p /data /app && chown bun:bun /data /app
WORKDIR /app
# Isolated, pinned MCP runtime; no root/developer node_modules enters the image.
COPY --chown=bun:bun deploy/team-hub/runtime/package.json deploy/team-hub/runtime/bun.lock ./
USER bun
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --chown=bun:bun src/hub ./src/hub
COPY --chown=bun:bun src/flow/machine.ts src/flow/types.ts ./src/flow/
# The revision-operand guard src/hub/git-delivery.ts and src/hub/connector.ts import at runtime.
COPY --chown=bun:bun src/lib/git-revision.ts ./src/lib/
COPY --chown=bun:bun src/remote-control ./src/remote-control
COPY --chown=bun:bun docs/requirements/hub-remote-sessions ./docs/requirements/hub-remote-sessions
ENV KERYX_HUB_HOST=0.0.0.0 KERYX_HUB_PORT=8787 KERYX_HUB_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD bun -e 'const r = await fetch("http://127.0.0.1:8787/healthz"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "src/hub/main.ts"]
