.DEFAULT_GOAL := help

NPM ?= npm
ARCH ?= $(shell node -p 'process.arch')
SILENT ?= 1
ifeq ($(OS),Windows_NT)
HOST_OS := Windows
SHELL := cmd.exe
.SHELLFLAGS := /c
else
HOST_OS := $(shell uname -s)
endif
MACOS_INSTALL_DIR ?= /Applications
ANDROID_GIT_REMOTE ?= https://github.com/dearmai/bright-term-vault.git
ANDROID_GIT_USERNAME ?= dearmai

.PHONY: help deps build deb install test android-deps android-build android-run

export ADB ANDROID_SERIAL ANDROID_APK NPM ANDROID_GIT_REMOTE ANDROID_GIT_USERNAME ANDROID_DEPLOY_CONFIG

help:
	@echo make build    Build Windows signed packages or the macOS/Linux application directory
	@echo make install  Build and install on Windows, macOS or Ubuntu/Debian/HamoniKR
	@echo make install SILENT=0  Show the Windows setup wizard instead of silent installation
	@echo make deb      Build a Linux deb package, ARCH=arm64 for ARM64
	@echo make test     Build and run Linux tests
	@echo make android-build  Build the Android debug APK
	@echo make android-run    Build, install and launch via adb

deps: node_modules/.brightterm-deps
	node node_modules/electron/install.js

node_modules/.brightterm-deps: package.json package-lock.json scripts/fix-node-pty.mjs
	$(NPM) ci
	node -e "require('fs').writeFileSync('node_modules/.brightterm-deps', '')"

ifeq ($(HOST_OS),Windows)
build: deps
	$(NPM) run dist:win:signed

install: build
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1 $(if $(filter 1,$(SILENT)),-Silent,)
else ifeq ($(HOST_OS),Darwin)
build: deps
	node scripts/prepare-macos-signing.cjs
	$(NPM) run dist:mac:dir -- --$$(node -p 'process.arch')

install: build
	bash scripts/install-macos.sh "$(MACOS_INSTALL_DIR)"
else ifeq ($(HOST_OS),Linux)
build: deps
	$(NPM) run dist:linux:dir -- --$(ARCH)

install: deb
	bash scripts/install-linux.sh
else
build install:
	@echo 'make build/install supports Windows, macOS and Linux.' >&2; exit 1
endif

deb: deps
	$(NPM) run dist:linux:deb -- --$(ARCH)

test: deps
	$(NPM) run test:linux

# Android does not need Electron downloads or native desktop modules.
android-deps:
	bash scripts/android-build.sh --deps-only

android-build:
	bash scripts/android-build.sh

android-run: android-build
	bash scripts/android-run.sh
