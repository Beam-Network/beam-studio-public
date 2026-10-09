FROM golang:1.23-alpine AS build

ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=dev

WORKDIR /src/apps/updater
COPY apps/updater/go.mod ./
RUN go mod download
COPY apps/updater/ ./
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
  go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
  -o /out/beam-updater ./cmd/beam-updater

FROM scratch
COPY --from=build /out/beam-updater /beam-updater
COPY deploy/compose.release.template.yml /compose.release.template.yml
ENTRYPOINT ["/beam-updater"]
