FROM node:22-slim

# Instalar ffmpeg y yt-dlp. El runtime de JavaScript que yt-dlp necesita para YouTube
# (--js-runtimes node) es el Node de esta misma imagen.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
