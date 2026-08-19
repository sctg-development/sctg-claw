# Build the mobile-auth-broker service
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git build-base

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# go-sqlite3 requires cgo; build-base above provides the musl gcc toolchain
RUN CGO_ENABLED=1 GOOS=linux go build -o /mobile-auth-broker ./cmd/main.go

# Final stage
FROM alpine:3.18

WORKDIR /app

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates tzdata

# Copy binary
COPY --from=builder /mobile-auth-broker /app/mobile-auth-broker

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 8080

ENTRYPOINT ["/app/mobile-auth-broker"]
