FROM node:24-bookworm-slim

WORKDIR /app

ENV API_HOST=0.0.0.0
ENV API_PORT=8787
ENV CHAPTERLENS_CACHE_DIR=/tmp/chapterlens-cache
ENV NODE_ENV=production
ENV STATIC_DIR=/app/dist

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8787

CMD ["npm", "run", "container:start"]
