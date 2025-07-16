FROM node:24-alpine

# Install Chromium & required libs
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    fontconfig \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Disable Puppeteer's own Chromium download, and point to system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Create a non-root user for Chromium sandbox
RUN addgroup -S puppeteer && adduser -S -G puppeteer puppeteer

# Set working directory
WORKDIR /usr/src/app

# Copy package manifest & install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy fetcher script
COPY fetcher.js ./

# Change to non-root user
USER puppeteer

# Entrypoint
ENTRYPOINT ["node", "fetcher.js"]