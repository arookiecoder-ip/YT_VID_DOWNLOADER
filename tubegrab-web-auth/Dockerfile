FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates python3 python3-mutagen ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# yt-dlp needs a JS runtime to solve YouTube's n-challenge (throttle bypass).
# Node.js is already available in this image — symlink it where yt-dlp looks.
RUN ln -sf /usr/local/bin/node /usr/bin/node

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p downloads

EXPOSE 3000
ENV NODE_ENV=production
# Update yt-dlp to latest at container start to avoid stale cached binaries
CMD yt-dlp -U --quiet 2>/dev/null || true && node server.js
