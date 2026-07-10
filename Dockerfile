# syntax=docker/dockerfile:1
FROM node:20-slim AS build
# better-sqlite3 compiles its native binding if no prebuild matches; build tools stay in
# this stage only, never shipped to runtime.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY web ./web
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
