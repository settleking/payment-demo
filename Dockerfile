# Tempo Dance Studio: the React site is built and served by the NestJS API on one port.
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS backend
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4400 \
    DATA_DIR=/data \
    FRONTEND_DIST=/app/frontend/dist
WORKDIR /app
COPY --from=backend /app/backend/package.json backend/package.json
COPY --from=backend /app/backend/node_modules backend/node_modules
COPY --from=backend /app/backend/dist backend/dist
COPY --from=frontend /app/frontend/dist frontend/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4400
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4400/api/health >/dev/null || exit 1
CMD ["node", "backend/dist/main.js"]
