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

COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src

EXPOSE 3001 3002

CMD ["npm", "run", "dev"]
