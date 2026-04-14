FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates python3 python3-pip ffmpeg curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip with the [default] extra which includes the EJS
# challenge solver scripts needed to bypass YouTube's n-challenge on headless servers.
RUN pip3 install --break-system-packages -U "yt-dlp[default]"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p downloads

EXPOSE 3000
ENV NODE_ENV=production
CMD node server.js
