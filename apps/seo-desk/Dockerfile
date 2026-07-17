FROM node:20-alpine

# libc6-compat: Next.js SWC binaries need the glibc loader on alpine, or
# `next build` fails. Python stack powers the SEO desk's scripting features.
RUN apk add --no-cache libc6-compat python3 py3-pip gcc musl-dev python3-dev

# Install Python packages
RUN pip3 install --break-system-packages \
    requests \
    cloudscraper \
    google-analytics-data \
    gspread \
    google-auth \
    pandas \
    oauth2client \
    lxml \
    google-api-python-client

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# lib/mongodb/client.ts throws at import time if MONGODB_URI is unset, which
# breaks `next build`'s page-data collection. Provide a build-time placeholder;
# it never connects during build and the real value is injected at runtime by
# docker-compose.
ARG MONGODB_URI=mongodb://placeholder:27017/build
ENV MONGODB_URI=$MONGODB_URI
RUN npm run build

ENV NODE_ENV=production
ENV PYTHON_EXECUTABLE=python3

EXPOSE 3000

CMD ["npm", "start"]
