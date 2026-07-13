FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
  ca-certificates \
  chromium \
  freetype \
  harfbuzz \
  nss \
  ttf-freefont

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src

EXPOSE 3001 3002

CMD ["npm", "run", "dev"]
