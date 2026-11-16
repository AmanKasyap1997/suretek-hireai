FROM node:26-bookworm-slim AS build
WORKDIR /app
# One source copy and one install/build layer also keep VFS-backed builders small.
COPY . .
RUN npm ci \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && mkdir /runtime \
    && mv node_modules dist package.json package-lock.json database /runtime/

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
