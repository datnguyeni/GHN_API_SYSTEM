FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY demo ./demo
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 GHN_DB_PATH=/app/data/shipping.sqlite GHN_CONFIG_FILE=/app/config/service.json
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY backend ./backend
COPY package.json ./
RUN mkdir -p /app/data /app/config && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/server.mjs"]
