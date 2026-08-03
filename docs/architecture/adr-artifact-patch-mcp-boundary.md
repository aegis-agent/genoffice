# ADR: Host-local Artifact Patch MCP boundary

- **Status:** Accepted for Phase 4
- **Date:** 2026-08-03
- **Scope:** `packages/artifact-patch-mcp`

## Decision

Expose the reviewed DOCX runtime through a host-local MCP v2 server over **stdio only**. The slice opens no HTTP, TCP, Unix-domain, or WebSocket listener and is not deployed as a persistent service.

The host must supply `ARTIFACT_ROOT` as an absolute, existing, non-symlink directory. Tool paths are relative `.docx` paths. Absolute paths, traversal, dot segments, backslashes, NULs, symlink components, dangling links, missing destination parents, and existing destinations are rejected. The source is never overwritten.

The public tools are:

1. `docx_inspect` — read-only inspection.
2. `docx_preview_patch` — validates a source/destination pair, produces a proposal and preview, and stores an opaque destination-bound confirmation record.
3. `docx_apply_patch_to_copy` — consumes that one-use confirmation before attempting the transactional copy.

Confirmation references contain 128 random bits, expire after ten minutes, and are capped at 64 pending records and by retained proposal text (262,144 characters per proposal; 1,048,576 aggregate). A failed apply still consumes the reference. The caller cannot redirect a confirmed operation because source, destination, and proposal are retained server-side.

Source bytes are opened with `O_NOFOLLOW`, checked with `fstat` before allocation, and read through a bounded chunk loop. MCP input defaults to 16 MiB and cannot exceed 64 MiB; operations, proposal text, inspection blocks, and aggregate inspection text are independently capped. Before inspect, preview, and apply, MCP runs a fail-closed in-memory DOCX ZIP preflight (central-directory metadata + bounded STORE/DEFLATE expansion checks; ZIP64/multi-disk/encrypted/unsupported methods rejected; `word/document.xml` required). Apply also injects that bounded reader and preflight as the transactional runtime's filesystem read capability, so its exact source and published-destination reads cannot bypass the MCP limits. Same-UID path-policy races remain an accepted boundary.

**Error-code stability:** Tool `structuredContent` codes apply to handler-level failures after protocol/schema validation succeeds. Calls that fail MCP SDK input-schema or protocol validation receive standard MCP `InvalidParams` with SDK free-form text rather than tool structured codes. Advertised schemas stay strict; InvalidParams is the intentional seam, not a leak of filesystem or dependency detail that handlers would sanitize.

All handled failures return stable non-leaking codes. Successful results contain relative paths only. Source text is returned intentionally by inspect/preview and is therefore within the trusted MCP-client boundary.

## Threat boundary

The server limits an MCP client to one explicit filesystem capability root. It does not defend against another process running as the same OS user changing filesystem entries between validation and use; that limitation is documented rather than disguised as a sandbox guarantee.

Remote/tailnet HTTP transport, authentication, Hermes registration, systemd installation, and deployment are intentionally deferred. Each needs a separate authorization and threat review.

## Consequences

- Local clients get a narrow, auditable DOCX edit flow without arbitrary filesystem access.
- Apply remains non-destructive: it creates a new file and refuses overwrite.
- The service is host-local rather than remotely discoverable.
- Runtime audit reports zero production dependency vulnerabilities; monorepo development dependencies retain pre-existing audit findings.

## Sources

- MCP TypeScript SDK v2 server guide: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
- MCP stdio server entry: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/stdio.ts
- MCP tools specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
