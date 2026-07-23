# ADR-0002b: Chat Attachments

**Status:** Superseded by ADR-0012
**Date:** 2026-07-16  
**Parent:** ADR-0002 (Chat Interface — Lightweight Web Client over ACP)
**Superseded:** Decision 2's repository-local storage path is replaced by a daemon-owned repository namespace beneath `MARSHAL_HOME`. The validation, quota, metadata, capability, and recovery decisions remain historical design context.

## Context

Phase 1 chat needs a safe screenshot path without making the browser a second
source of truth. Attachments cross an untrusted multipart boundary, consume
disk and memory, and may need to be converted to ACP image content. ACP agents
advertise image prompt support during `initialize`; agents that do not advertise
it must not receive silently dropped images.

## Decisions

1. **The daemon owns attachment persistence.** Uploads use
   `POST /api/threads/:id/attachments` and are scoped to the repository-owned
   thread. The daemon returns an opaque UUID reference and metadata; clients do
   not choose storage paths or URLs.
2. **Storage is repo-local and bounded.** Bytes live below
   `.marshal/attachments/<thread-id>/<attachment-id>`, with a database metadata
   row. Phase 1 allows PNG, JPEG, WebP, and GIF, with a 10 MiB per-file limit,
   8 attachments per send, and a 40 MiB total attachment quota per thread.
   Uploads are rejected before reading when `Content-Length` exceeds the
   limit, and the parsed multipart body is checked again before persistence.
   The server stores bytes as received, never uses the client filename as a
   path component, and deletes attachment files with their thread.
3. **Validation is defense in depth.** The declared MIME type, filename
   extension, and file signature must agree with an allowed image format.
   Unknown, spoofed, empty, oversized, or malformed files receive a structured
   422 error. No image is decoded or resized by Marshal.
4. **Messages persist references, not base64.** A user message stores the
   attachment references in a bounded JSON envelope alongside its text. The
   attachment metadata is returned from thread detail and can be fetched only
   through a thread-scoped endpoint. This keeps transcript storage inspectable
   and avoids unbounded inline message values.
5. **ACP forwarding is capability-gated.** When a turn has images, the direct
   ACP adapter sends text plus base64 image `ContentBlock`s only when the
   negotiated `promptCapabilities.image` is true. Otherwise the send fails
   before creating the user message, with an explicit unsupported-image error;
   images are never silently converted to text or dropped. Fake agents can
   advertise the same capability through the adapter-neutral session metadata.
6. **Upload and send failures are recoverable.** Failed uploads leave no
   metadata or partial file. A failed send leaves uploaded attachments intact
   so the user can retry or remove them; the UI reports the daemon error inline
   and keeps the draft. Attachment downloads are not exposed as general static
   files.

## Consequences

- Screenshots survive reloads and can be reused for a retry within the thread.
- The daemon remains authoritative for validation, ownership, quota, and ACP
  capability checks.
- A 10 MiB image may briefly be held by the multipart parser, but the endpoint
  rejects oversized requests using `Content-Length` and never accepts an
  unbounded request body.
- Agents without ACP image support cannot process image turns in Phase 1; the
  explicit error is preferable to misleading agent context.
- Attachment garbage collection beyond thread deletion is deferred; the
  per-thread quota and limits keep the Phase 1 store bounded.
