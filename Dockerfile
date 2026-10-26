# Multi-arch (amd64 + arm64, so it runs on a VPS and on a Raspberry Pi 4/5):
#   docker buildx build --platform linux/amd64,linux/arm64 -t pooltable:latest .
# No build step and no runtime dependencies: Node 22 runs the TypeScript directly.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 --home /app --shell /usr/sbin/nologin app && mkdir -p /data /backups && chown app:app /data /backups
COPY --chown=app:app package.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app web ./web
COPY --chown=app:app scripts ./scripts
USER app
ENV DB_PATH=/data/pooltable.db HOST=0.0.0.0 PORT=8080 TRUST_PROXY=1 HSTS=1 BACKUP_DIR=/backups
EXPOSE 8080
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
