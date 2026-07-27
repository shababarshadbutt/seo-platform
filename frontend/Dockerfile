FROM node:20-alpine

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package*.json ./
RUN npm install

COPY . .

# Real production build. Note the deliberate absence of NEXT_PUBLIC_BACKEND_URL /
# NEXT_PUBLIC_SEO_DESK_URL build args: those were replaced by runtime config
# (BACKEND_URL via the /api/backend/* rewrite, SEO_DESK_URL via /api/config), so
# this image carries no environment-specific URL and the same artifact deploys
# anywhere. NEXT_PUBLIC_APP_VERSION is the one value that IS build-time, and it
# is genuinely static per image.
ARG NEXT_PUBLIC_APP_VERSION=""
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]

