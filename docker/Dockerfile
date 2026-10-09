FROM --platform=$BUILDPLATFORM golang:1.26 AS process-guard
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY packages/action-runtime/process-guard/ ./
RUN node_arch="$TARGETARCH"; if [ "$TARGETARCH" = amd64 ]; then node_arch=x64; fi; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -o "/out/process-guard-linux-$node_arch" .

FROM --platform=$BUILDPLATFORM node:22-slim AS build-base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM build-base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/action-runtime/package.json ./packages/action-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/vault/package.json ./packages/vault/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY apps ./apps
COPY packages ./packages

FROM source AS workspace-packages
RUN pnpm turbo build \
  --filter=@beam-studio/action-runtime \
  --filter=@beam-studio/core \
  --filter=@beam-studio/db \
  --filter=@beam-studio/shared \
  --filter=@beam-studio/ui \
  --filter=@beam-studio/vault

FROM workspace-packages AS worker-build
RUN pnpm --filter @beam-studio/worker build
COPY --from=process-guard /out/ /app/packages/action-runtime/native/
RUN pnpm --filter @beam-studio/action-runtime deploy --prod --legacy /opt/beam-action-runtime

FROM workspace-packages AS mcp-build
RUN pnpm --filter @beam-studio/mcp-server build

FROM --platform=$TARGETPLATFORM node:22-slim AS runtime-base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

FROM runtime-base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/action-runtime/package.json ./packages/action-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/vault/package.json ./packages/vault/package.json
RUN pnpm install --prod --frozen-lockfile

FROM prod-deps AS worker
ENV NODE_ENV=production
COPY --from=worker-build /app/apps ./apps
COPY --from=worker-build /app/packages ./packages
COPY --from=worker-build /opt/beam-action-runtime /opt/beam-action-runtime
WORKDIR /app/apps/worker
CMD ["node", "--env-file-if-exists=../../.env.local", "dist/main.js"]

FROM prod-deps AS mcp
ENV NODE_ENV=production
COPY --from=mcp-build /app/apps ./apps
COPY --from=mcp-build /app/packages ./packages
EXPOSE 8766
CMD ["pnpm", "--filter", "@beam-studio/mcp-server", "start"]
