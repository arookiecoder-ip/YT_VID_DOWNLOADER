FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates python3 python3-pip ffmpeg && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip with the [default] extra which includes the EJS
# challenge solver scripts needed to bypass YouTube's n-challenge on headless servers.
# Remove any pre-existing yt-dlp binary so only the pip-installed version is used.
RUN pip3 install --break-system-packages -U "yt-dlp[default]" && \
    rm -f /usr/local/bin/yt-dlp && \
    ln -sf "$(python3 -c 'import sysconfig; print(sysconfig.get_path(\"scripts\"))')/yt-dlp" /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p downloads

EXPOSE 3000
ENV NODE_ENV=production
CMD node server.js
