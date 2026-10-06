.DEFAULT_GOAL := help

NPM ?= npm

.PHONY: help deps build deb install test

help:
	@printf '%s\n' \
	  'make build    Build the Linux application directory' \
	  'make deb      Build a Linux deb package' \
	  'make install  Build and install on Ubuntu/Debian/HamoniKR (sudo for installation only)' \
	  'make test     Build and run Linux tests (graphical session required)'

deps: node_modules/.brightterm-deps
	node node_modules/electron/install.js

node_modules/.brightterm-deps: package.json package-lock.json scripts/fix-node-pty.mjs
	$(NPM) ci
	@touch "$@"

build: deps
	$(NPM) run dist:linux:dir

deb: deps
	$(NPM) run dist:linux:deb

install: deb
	bash scripts/install-linux.sh

test: deps
	$(NPM) run test:linux
