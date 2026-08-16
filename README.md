# Secure Desktop Connector Demo

A runnable, mock-only reference implementation of a secure Electron-to-control-plane bridge.

It demonstrates the hard parts of a desktop connector without containing a real provider driver, browser automation, credentials, cookies or private API calls.

## What it demonstrates

- one-time device pairing;
- Ed25519 identity generated on the desktop;
- canonical signed requests with timestamp and replay protection;
- opaque device token stored only as a digest by the demo server;
- random AES-256-GCM vault key protected by Electron `safeStorage`;
- encrypted local device credentials, mock profiles and durable command receipts;
- atomic `0600` files and explicit local reset;
- HTTPS-only remote origins, with localhost HTTP allowed for development;
- bounded response bodies, rejected redirects and strict Zod schemas;
- sandboxed, context-isolated renderer with a narrow validated IPC bridge;
- Electron fuses that disable RunAsNode, Node options and CLI inspection;
- deterministic network-free demo commands with no external platform access.

## Requirements

- Node.js 22+;
- npm;
- a desktop keychain supported by Electron `safeStorage`.

Linux requires Secret Service/KWallet. Electron's insecure `basic_text` backend is deliberately rejected. Headless containers normally cannot pass the keychain check; run the desktop app in a normal graphical session.

## Install and verify

```bash
npm ci
npm run verify
```

## Run the complete demo

Terminal 1:

```bash
npm run demo-server
```

The server binds to `127.0.0.1:8787` and prints a one-time pairing code. It stores all state in memory and exposes only the demo connector routes.

Terminal 2, in a graphical desktop session:

```bash
npm run desktop
```

Use `http://127.0.0.1:8787`, paste the pairing code, add a `demo` profile and click “run once”. The control plane queues one `VERIFY_PROFILE` command; the desktop executes it through the encrypted mock vault and returns a signed result.

## Build an unpacked desktop application

```bash
npm run package:desktop
```

Electron Forge can create platform-specific installers with `npm run make:desktop`. Public binaries are intentionally not attached to this repository: production distribution should add code signing, artifact verification and a separately reviewed release process.

## Security boundary

This project is a reference demo, not a production remote-access agent. It does not include automatic updates, real CRM code, external-platform integrations or credential collection. Review [SECURITY.md](SECURITY.md) before adapting it.

## Project layout

- `src/connector/protocol.ts` — schemas, canonical requests and signature verification;
- `src/connector/desktop/` — identity, key store, encrypted vaults, receipt cache and runtime;
- `desktop-connector/src/` — Electron main/preload/renderer, HTTP transport and demo server;
- `src/connector/__tests__/` — vault, replay-safe runtime and end-to-end signed transport tests.
