.DEFAULT_GOAL := help

NPM ?= npm
HOST_OS := $(shell uname -s)
MACOS_INSTALL_DIR ?= /Applications

.PHONY: help deps build deb install test

help:
	@printf '%s\n' \
	  'make build    Build the application directory for macOS or Linux' \
	  'make deb      Build a Linux deb package' \
	  'make install  Build and install on macOS or Ubuntu/Debian/HamoniKR' \
	  'make test     Build and run Linux tests (graphical session required)'

deps: node_modules/.brightterm-deps
	node node_modules/electron/install.js

node_modules/.brightterm-deps: package.json package-lock.json scripts/fix-node-pty.mjs
	$(NPM) ci
	@touch "$@"

ifeq ($(HOST_OS),Darwin)
build: deps
	node scripts/prepare-macos-signing.cjs
	$(NPM) run dist:mac:dir -- --$$(node -p 'process.arch')

install: build
	bash scripts/install-macos.sh "$(MACOS_INSTALL_DIR)"
else ifeq ($(HOST_OS),Linux)
build: deps
	$(NPM) run dist:linux:dir

install: deb
	bash scripts/install-linux.sh
else
build install:
	@echo 'make build/install supports macOS and Linux.' >&2; exit 1
endif

deb: deps
	$(NPM) run dist:linux:deb

test: deps
	$(NPM) run test:linux
