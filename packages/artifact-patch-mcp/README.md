# @genoffice/artifact-patch-mcp

Host-local **stdio** MCP server around `@genoffice/artifact-patch`.

## Run

```bash
ARTIFACT_ROOT=/absolute/path/to/artifacts \
  ./node_modules/.bin/tsx packages/artifact-patch-mcp/src/cli.ts
# npm-script alternative; --silent is required to keep stdout protocol-only:
ARTIFACT_ROOT=/absolute/path/to/artifacts \
  npm run --silent start -w @genoffice/artifact-patch-mcp
```

- Opens **no network socket**. stdout is MCP JSON-RPC only; logs go to stderr.
- `ARTIFACT_ROOT` must be an explicit absolute existing non-symlink directory (no cwd/home fallback).

## Tools

1. `docx_inspect` — read-only inspect of a root-relative `.docx`
2. `docx_preview_patch` — preview ops + mint destination-bound confirmation (no writes)
3. `docx_apply_patch_to_copy` — consume confirmation and apply via `applyDocxPatchToCopy`

## Path policy

All tool paths are root-relative `.docx` paths. Absolute paths, `..`/`.`, backslashes, drive letters, non-`.docx`, and symlinks (including dangling destination symlinks) are rejected. Destination must not exist; parents must exist as real directories.

## Confirmation

Opaque random refs (≥128 bits), TTL 10 minutes, max 64 pending, one-use (consumed before apply). Server memory only. Pending confirmations are also bounded by retained proposal text (262,144 characters per proposal; 1,048,576 aggregate); oldest records are evicted when either the count or text budget is exceeded.

## Resource bounds

- Compressed DOCX input defaults to 16 MiB and cannot exceed 64 MiB through MCP; source reads use a pre-allocation `fstat` gate, `O_NOFOLLOW`, and a bounded chunk loop.
- Before `inspectDocx` / preview and before apply invokes the transactional runtime, MCP runs a fail-closed DOCX ZIP preflight over bounded source bytes (entry count, per-entry and aggregate expanded size, STORE/DEFLATE verification, required `word/document.xml`). Apply also injects the same bounded reader and preflight into the transactional runtime, covering its exact source and destination re-reads. ZIP64, multi-disk, encrypted, and unsupported compression methods are rejected.
- A proposal accepts at most 64 operations and at most 262,144 total expected+replacement text characters.
- Inspection results are capped at 10,000 blocks and 1,000,000 aggregate text characters.

## Error semantics

Stable structured error codes (`structuredContent.code` / safe message) apply to **handler-level** failures after the MCP SDK has accepted the call against the advertised input schema. Malformed calls that fail protocol or schema validation are rejected by the SDK with standard MCP `InvalidParams` (free-form SDK text) and do not produce tool `structuredContent`. Schemas remain strict; this package does not weaken them to funnel every validation failure through handler codes.

## Limits

Same-UID filesystem races are not prevented — this is not a sandbox against another process running as the same user.
