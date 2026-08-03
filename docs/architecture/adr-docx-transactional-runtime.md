# ADR: DOCX transactional runtime package boundary

- Status: Accepted
- Date: 2026-08-03
- Deciders: GenOffice artifact-patch slice

## Context

We need a local library nucleus for a future tailnet-only Artifact Patch Service /
MCP that can inspect a DOCX, propose a strict text-replace patch, preview a pure
diff, apply to a destination copy with atomic no-overwrite publication, validate
roundtrip, and return a provenance manifest.

Format knowledge already lives in `@genoffice/docx-engine` (Block tree with
`docxIndex` anchors, OOXML surgical paragraph patching via internal
`patchParagraphTexts`, and paragraph-patch save). Transaction policy (proposal
integrity, filesystem publication, provenance) is orthogonal to OOXML fidelity.

## Options

### A. Separate transaction package + DOCX adapter (chosen)

Add a private workspace package `@genoffice/artifact-patch` that:

- owns proposal schemas, deterministic proposal IDs, preview purity,
  apply-to-copy filesystem policy, roundtrip validation, and provenance manifests;
- imports `@genoffice/docx-engine` for parse / surgical body-paragraph patch /
  save;
- keeps format-specific knowledge (runs, originalXml, zip parts) inside
  docx-engine, exposing only a narrow helper (`patchBodyParagraphText`) for this
  slice — `patchParagraphTexts` remains internal to the engine.

### B. Embed policy in docx-engine

Fold proposal Zod schemas, path publication, and provenance into
`@genoffice/docx-engine`.

### C. Build network endpoints now

Stand up HTTP/MCP endpoints and wire transport before the local nucleus exists.

## Decision

**Choose A.**

## Consequences

### Why not B

- docx-engine is already a large OOXML fidelity surface used by the desktop
  editor. Mixing transactional file policy, hash-bound proposals, and
  provenance would couple editor save paths to service-oriented contracts and
  inflate the engine's public API.
- Transaction rules (exclusive create, `FileHandle.sync`, no-overwrite `link`,
  refuse pre-existing destinations including symlinks) are filesystem policy,
  not WordprocessingML knowledge.
- Future formats (XLSX/PPTX) would either fork parallel policy inside each
  engine or force awkward shared modules inside a DOCX-named package.

### Why not C

- Network endpoints imply authn/z, tailnet binding, request size limits, and
  multi-tenant error surfaces before the pure library contract is proven.
- This slice is explicitly local-only: no server, no UI, no MCP surface, no
  background service. Shipping transport first risks locking a half-valid apply
  path behind remote callers with weaker testability.
- A stable in-process API is the right control plane for a later Artifact Patch
  Service to wrap without re-deriving integrity rules.

### Why A

- Clear seam: engine = format truth; artifact-patch = transaction + file policy.
- Matches the required vertical slice and keeps existing docx-engine tests and
  behavior intact (additive narrow helper export only).
- Enables future adapters (other formats or remote wrappers) without rewriting
  OOXML internals.
- Aligns with Node 20 fs guarantees used at the publication boundary:
  - exclusive create via `fsPromises.open(path, 'wx')` (and symlink caveats)
    https://nodejs.org/docs/latest-v20.x/api/fs.html#fspromisesopenpath-flags-mode
  - durability via `FileHandle.sync()`
    https://nodejs.org/docs/latest-v20.x/api/fs.html#filehandlesync
  - no-overwrite atomic publish via `fsPromises.link(existingPath, newPath)`
    https://nodejs.org/docs/latest-v20.x/api/fs.html#fspromiseslinkexistingpath-newpath

## Implementation notes (this slice)

- Public flow: `inspectDocx` → `createDocxPatchProposal(inspection, request)` →
  `previewDocxPatch` → `applyDocxPatch` / `applyDocxPatchToCopy` →
  `validateDocxRoundtrip` (also enforced inside apply) → provenance manifest.
- Proposal creation is bound to a live `DocxInspection`: source hash/byte-length,
  expectedText freshness, editable anchors, and duplicates are rejected at
  creation time (not deferred to preview).
- Initial operation: `replace_block_text` only; CR/LF rejected; expectedText and
  replacementText both length-bounded; strict Zod at root and nested objects;
  operations sorted by `docxIndex` before ID derivation.
- File apply uses a strict Zod argument object (`applyDocxPatchToCopyArgsSchema`)
  including ISO-8601 `appliedAt` via Zod 4 `z.iso.datetime()`, nonempty bounded
  paths, optional bounded `maxCompressedBytes`, unknown root fields rejected.
  A trusted filesystem capability may be supplied only as a separate in-process
  argument for deterministic testing/embedding; it is never part of the wire object.
- Invalid DOCX and filesystem-inspection failures are translated to stable,
  constant-text machine errors without dependency messages, paths, or document text.
- In-memory apply requires validated `appliedAt` and returns a full provenance
  manifest (including output SHA-256/byte length). Manifest is re-parsed with
  `docxProvenanceManifestSchema` before return.
- Publication: stage `wx` + sync + `link`; re-read and verify against manifest
  output; on post-link verification failure, attempt to unlink the newly created
  destination (rollback). Temp-cleanup failures do not hide primary errors and
  do not yield silent success.
- Apply is all-or-nothing in memory; destination is never half-published on
  intentional success path.

## Explicit limitations

- DOCX only; single op type (`replace_block_text`); no multi-paragraph CR/LF text.
- Compressed-byte cap is not decompression-bomb containment.
- No Microsoft Office / LibreOffice interoperability run.
- No server / MCP / UI / network surface.
