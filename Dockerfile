FROM node:24-bookworm-slim AS verified
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib/ ./lib/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY server.mjs storage.mjs ./
# No production variables or volumes are available/needed for these tests.
# A failed test fails the image build, before any deployment can start.
RUN npm run verify

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=verified /app/package.json /app/package-lock.json ./
COPY --from=verified /app/node_modules ./node_modules
COPY --from=verified /app/lib ./lib
COPY --from=verified /app/public ./public
COPY --from=verified /app/scripts ./scripts
COPY --from=verified /app/server.mjs /app/storage.mjs ./
# Persistent storage is mounted at runtime; never include databases in the image.
USER node
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=6 CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT || 3000) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
