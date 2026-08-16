# Security

This repository is intentionally mock-only.

- Do not add passwords, cookies, browser sessions or private provider endpoints.
- Do not weaken the OS-keychain requirement with a plaintext fallback.
- Keep renderer networking disabled and validate every IPC sender and payload.
- Use HTTPS for non-local control planes and authenticate every post-pair request.
- Persist replay IDs and device revocation in a production server; the included demo server is in-memory by design.
- Add platform code signing and immutable artifact verification before distributing binaries to end users.
- Report vulnerabilities through GitHub private vulnerability reporting rather than a public issue.
