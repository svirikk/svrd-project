# Dockerfile
#
# Двостадійна збірка:
#   1) "builder"  — компілює C++ рушій (потрібен g++, у фінальному образі не потрібен)
#   2) "runtime"  — Node.js + Python/OpenCV (для convert.py) + скомпільований бінарник
#
# Так фінальний образ не тягне за собою повний build-essential toolchain.

# ---------- Стадія 1: компіляція C++ рушія ----------
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY cpp/ ./cpp/

RUN g++ -O2 -std=c++17 \
    cpp/string-art.cpp cpp/Image.cpp cpp/StringArtImage.cpp cpp/StringArtist.cpp \
    -o string-art


# ---------- Стадія 2: рантайм ----------
FROM node:20-bookworm-slim AS runtime

# Python + OpenCV для convert.py / pgm_to_image.py.
# libgl1/libglib2.0-0 потрібні навіть для "headless" збірки opencv-python
# (деякі підмодулі OpenCV лінкуються проти них під час імпорту).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
    opencv-python-headless==4.13.* \
    numpy

WORKDIR /app

# Спершу залежності Node окремим шаром — кешується, поки package.json не міняється.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Застосунок
COPY server/ ./server/
COPY public/ ./public/
COPY convert.py pgm_to_image.py ./

# Скомпільований бінарник з першої стадії
COPY --from=builder /build/string-art ./bin/string-art
RUN chmod +x ./bin/string-art

# tmp/ для тимчасових файлів генерації, data/orders/ для постійних записів
# замовлень (застосунок складання) — обидві створюються й самим сервером,
# але нехай існують з правильними правами одразу.
RUN mkdir -p tmp data/orders && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
