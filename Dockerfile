# Bull Stake — single-service deploy: the engine serves both /api and the
# built web app (WEB_DIST same-origin mode). Build context = repo root because
# the engine imports spike/ (TxLINE auth) and keeper/ (shared card/feed logic)
# sources directly; tsx transpiles them at runtime.
FROM node:22-slim
WORKDIR /app

# Per-package installs — the repo has no npm workspaces on purpose.
COPY spike/package.json spike/package-lock.json spike/
COPY keeper/package.json keeper/package-lock.json keeper/
COPY engine/package.json engine/package-lock.json engine/
COPY web/package.json web/package-lock.json web/
RUN cd spike && npm ci && cd ../keeper && npm ci && cd ../engine && npm ci && cd ../web && npm ci

COPY spike spike
COPY keeper keeper
COPY engine engine
COPY web web
# Deploy supervisor (repo-root file; note .dockerignore excludes scripts/).
COPY start-prod.mjs .
# Anchor IDL: engine/idl/ is the tracked deploy mirror (target/ is gitignored,
# and railway up drops gitignored paths from the context even when tracked).
# Placed at the canonical target/idl/ path so every default resolves unchanged.
COPY engine/idl/proofbet.json target/idl/proofbet.json

# Client bundle config is baked at build time. Railway forwards service
# variables as build args for the ARGs declared here. VITE_ENGINE_URL stays ""
# so the app calls /api on its own origin.
ARG VITE_ENGINE_URL=""
ARG VITE_RPC_URL
ARG VITE_PRIVY_APP_ID
RUN cd web && VITE_ENGINE_URL="$VITE_ENGINE_URL" VITE_RPC_URL="$VITE_RPC_URL" VITE_PRIVY_APP_ID="$VITE_PRIVY_APP_ID" npm run build

ENV WEB_DIST=/app/web/dist
EXPOSE 8787
# Supervisor runs the engine (always) + the keeper cron (opt-in via RUN_KEEPER=1).
# With RUN_KEEPER unset it behaves exactly like `npm --prefix engine run start`.
CMD ["node", "start-prod.mjs"]
