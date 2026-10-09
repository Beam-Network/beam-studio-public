FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/studio/package.json ./apps/studio/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/action-runtime/package.json ./packages/action-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/vault/package.json ./packages/vault/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter "{./apps/api}..." build

FROM base AS runtime
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/studio/package.json ./apps/studio/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/action-runtime/package.json ./packages/action-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/vault/package.json ./packages/vault/package.json
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
# The git commit this image was built from (set by the deploy workflow). Last,
# so a new revision does not invalidate the cached layers above.
ARG BEAM_REVISION=""
ENV BEAM_REVISION=$BEAM_REVISION
EXPOSE 8787
CMD ["sh", "-c", "pnpm --filter ./packages/db db:studio:init && pnpm --filter ./apps/api start"]
