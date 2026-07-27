FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
  ca-certificates \
  chromium \
  freetype \
  harfbuzz \
  nss \
  ttf-freefont

# Raise the V8 heap ceiling above the 2GB default so a large Sitemap Cleaner run
# (many big XML files → a multi-million-entry dedup Set) has headroom. The
# cleaner itself streams files to/from disk (v1.38) so this is a safety net, not
# the fix. Overridable per-service via NODE_OPTIONS in docker-compose.yml.
ENV NODE_OPTIONS="--max-old-space-size=4096"

COPY package*.json ./
RUN npm install

COPY tsconfig.json tsconfig.build.json ./
COPY migrations ./migrations
COPY src ./src

# Compile to dist at IMAGE BUILD time. This box is a shared, always-on
# production deployment: `tsx watch` would re-exec the API whenever anything
# touched a source path, which on a multi-user VM is a real interruption, and
# transpiling on every worker-thread spawn is pure overhead. The piscina pools
# detect the compiled build and load dist/workers/*.js without tsx
# (see src/jobs/workerRuntime.ts).
RUN npm run build

EXPOSE 3001 3002

CMD ["npm", "run", "start"]
