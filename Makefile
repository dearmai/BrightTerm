.DEFAULT_GOAL := help

NPM ?= npm
ANDROID_GIT_REMOTE ?= https://github.com/dearmai/bright-term-vault.git
ANDROID_GIT_USERNAME ?= dearmai

.PHONY: help deps build deb install test android-deps android-build android-run

export ADB ANDROID_SERIAL ANDROID_APK NPM ANDROID_GIT_REMOTE ANDROID_GIT_USERNAME ANDROID_DEPLOY_CONFIG

help:
	@printf '%s\n' \
	  'make build    Build the Linux application directory' \
	  'make deb      Build a Linux deb package' \
	  'make install  Build and install on Ubuntu/Debian/HamoniKR (sudo for installation only)' \
	  'make test     Build and run Linux tests (graphical session required)' \
	  'make android-build  Build the Android debug APK (JDK 17 / SDK 36)' \
	  'make android-run    Build, install and launch via adb (ANDROID_SERIAL selects a device)'

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

# Android does not need Electron downloads or native desktop modules.
android-deps:
	bash scripts/android-build.sh --deps-only

android-build:
	bash scripts/android-build.sh

android-run: android-build
	bash scripts/android-run.sh
