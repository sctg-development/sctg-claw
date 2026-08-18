# Makefile for mobile-auth-broker

DOCKER_IMAGE ?= sctg/mobile-auth-broker
DOCKER_TAG ?= latest
BINARY_NAME ?= mobile-auth-broker

.PHONY: all build docker push clean test test-cover test-race

all: build test

build:
	go build -o bin/$(BINARY_NAME) ./cmd/main.go

docker:
	docker build -t $(DOCKER_IMAGE):$(DOCKER_TAG) .

push:
	docker push $(DOCKER_IMAGE):$(DOCKER_TAG)

clean:
	rm -rf bin/
	docker rmi -f $(DOCKER_IMAGE):$(DOCKER_TAG) 2>/dev/null || true

# Run all tests
test:
	go test ./... -v

# Run tests with coverage
test-cover:
	go test ./... -coverprofile=coverage.out -v
	go tool cover -html=coverage.out -o coverage.html

# Run tests with race detector
test-race:
	go test ./... -race -v

# Run tests with short mode (skip long-running tests)
test-short:
	go test ./... -short -v

# Run tests for specific package
test-pkg:
	@echo "Usage: make test-pkg PKG=<package>"
	go test ./$(PKG) -v

# Run tests with verbose output and count
TEST_V ?= 1
test-verbose:
	go test ./... -v -count=$(TEST_V)

# Lint
lint:
	golangci-lint run ./...

# Format code
fmt:
	gofmt -w .

# Generate dependencies
deps:
	go mod tidy

# Run the broker locally for development
dev:
	go run ./cmd/main.go

# Run with environment variables from .env file
dev-env:
	@if [ -f .env ]; then \
		export $(cat .env | xargs) && \
		go run ./cmd/main.go; \
	else \
		echo ".env file not found, using default environment"; \
		go run ./cmd/main.go; \
	fi

# Build and push multi-arch image
multi-arch:
	docker buildx build --platform linux/amd64,linux/arm64 -t $(DOCKER_IMAGE):$(DOCKER_TAG) --push .

# Run tests in watch mode
test-watch:
	@echo "Watching for changes and running tests..."
	@while true; do \
		clear; \
		go test ./... -v -count=1; \
		sleep 5; \
	done

# Run specific test file
test-file:
	@echo "Usage: make test-file FILE=<test_file>"
	go test ./tests -v -run Test$(FILE)

# Run tests with coverage for specific package
test-cover-pkg:
	@echo "Usage: make test-cover-pkg PKG=<package>"
	go test ./$(PKG) -coverprofile=coverage.out -v
	go tool cover -html=coverage.out -o coverage.html

# Clean test artifacts
clean-tests:
	rm -f coverage.out coverage.html

# Run all tests including integration tests (if any)
test-all:
	go test ./... -v -tags=integration

# Help
help:
	@echo "Available targets:"
	@echo "  build            - Build the binary"
	@echo "  docker           - Build Docker image"
	@echo "  push            - Push Docker image"
	@echo "  test            - Run all tests"
	@echo "  test-cover      - Run tests with coverage"
	@echo "  test-race       - Run tests with race detector"
	@echo "  test-short      - Run tests in short mode"
	@echo "  lint            - Run linter"
	@echo "  fmt             - Format code"
	@echo "  dev             - Run locally for development"
	@echo "  multi-arch      - Build and push multi-arch image"
	@echo "  clean           - Clean build artifacts"
