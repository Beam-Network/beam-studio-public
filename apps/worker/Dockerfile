FROM --platform=$BUILDPLATFORM golang:1.26 AS process-guard
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY packages/action-runtime/process-guard/ ./
RUN node_arch="$TARGETARCH"; if [ "$TARGETARCH" = amd64 ]; then node_arch=x64; fi; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -o "/out/process-guard-linux-$node_arch" .

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
RUN pnpm --filter "{./apps/worker}..." build
COPY --from=process-guard /out/ /app/packages/action-runtime/native/
RUN pnpm --filter ./packages/action-runtime deploy --prod --legacy /opt/beam-action-runtime

FROM base AS runtime
ENV NODE_ENV=production
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
COPY --from=build /opt/beam-action-runtime /opt/beam-action-runtime
# The git commit this image was built from (set by the deploy workflow). Last,
# so a new revision does not invalidate the cached layers above.
ARG BEAM_REVISION=""
ENV BEAM_REVISION=$BEAM_REVISION
WORKDIR /app/apps/worker
CMD ["node", "--env-file-if-exists=../../.env.local", "dist/main.js"]
