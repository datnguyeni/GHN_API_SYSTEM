FROM node:22-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json next.config.mjs ./
COPY app ./app
RUN npm run build

FROM maven:3.9.11-eclipse-temurin-21 AS backend
WORKDIR /build
COPY backend ./backend
COPY --from=frontend /app/out ./out
RUN mvn -B -f backend/pom.xml -DskipTests package

FROM eclipse-temurin:21-jre-alpine
ENV HOST=0.0.0.0 PORT=8080 GHN_DB_PATH=/app/data/shipping.sqlite GHN_CONFIG_FILE=/app/config/service.json
WORKDIR /app
RUN addgroup -S shipping && adduser -S shipping -G shipping && mkdir -p /app/data /app/config && chown -R shipping:shipping /app
COPY --from=backend --chown=shipping:shipping /build/backend/target/shipping-service-1.1.0.jar /app/shipping-service.jar
USER shipping
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["java", "-jar", "/app/shipping-service.jar"]
