# Splat Arena: one image that runs the game server and serves the built website on the same port.
#
#   docker build -t splat-arena .
#   docker run -p 8080:8080 splat-arena            → http://localhost:8080
#
# Put it behind TLS (any reverse proxy or platform that supports WebSocket upgrades) so players
# on https:// pages can connect with wss://. Settings are environment variables; see docs/DEPLOY.md.
# To host the website somewhere else instead, build with --build-arg VITE_SERVER_URL=wss://game.example.com.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SERVER_URL
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/public
WORKDIR /app
COPY package.json package-lock.json ./
# the server bundle only needs ws, node-datachannel and dd-trace at runtime (three etc. are already baked into the
# website build). node-datachannel's native library comes prebuilt for this platform as an npm package,
# so there's nothing to compile and install scripts can stay off.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./public
# Datadog APM: loads dd-trace first when DD_TRACE_ENABLED=true, does nothing otherwise (docs/DATADOG.md)
COPY server/dd-init.mjs ./dd-init.mjs
USER node
EXPOSE 8080
# data channels, when RTC_UDP_PORT=8788 is set (see docs/DEPLOY.md)
EXPOSE 8788/udp
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1
# exec form, so SIGTERM reaches node directly and the server shuts down cleanly
CMD ["node", "--import", "./dd-init.mjs", "dist-server/index.js"]
