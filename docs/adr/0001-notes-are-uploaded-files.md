# ADR 0001 — Notes are uploaded files, not rendered documents

**Date:** 2026-08-08
**Status:** Accepted
**Supersedes:** Section 9.3 of the technical documentation, which was marked
`[CONFIRM]` pending this decision.

## Decision

Teachers upload notes as **PDFs and phone photographs of handwritten pages**.
There is no in-platform authoring. Students view them online only.

## What this removes

Section 9.3 specified a rich-text pipeline: Tiptap editor → JSON → HTML →
Satori → SVG → resvg-js → paginated PNG. All of it is dropped.

- `note_sources` table — deleted. There is no source document to re-edit; the
  uploaded file *is* the artifact.
- Tiptap, Satori, resvg-js, KaTeX — never added as dependencies.
- The `note.render` background job — never written.
- **Phase 5 of the roadmap (2 weeks)** — collapses into the R2 presigned upload
  work already in Phase 1. Notes become one more lesson type with a file.

## What this keeps

`note_pages` survives with a changed meaning: ordered pages of an uploaded
note, populated directly by the teacher's upload rather than by a render job.
A single-file PDF note uses `lessons.r2_object_key` alone. A photographed note
is N image rows in `note_pages`, ordered by `page_number`.

Delivery is unchanged from Section 4.1 flow B — presigned GET with a 15-minute
TTL, fetched into a `<canvas>`, watermark overlaid, never handed to the browser
as a file.

## The honest limit on "no downloading"

Section 17.3 already says this and it must not be softened when talking to
teachers:

- **Mobile: genuinely blocked.** `FLAG_SECURE` makes the Android compositor
  refuse to include the window in screenshots or recordings, and it covers
  PDFs and images, not only video.
- **Web: not blocked.** Canvas rendering stops right-click-save and makes text
  unselectable, so the file cannot be lifted and the notes cannot be
  bulk-copied. Print Screen still captures a canvas like anything else.

The defensible claim is: *not downloadable, watermarked with the student's name
and phone, and screenshot-proof in the app.* Not "protected".

This strengthens the Section 16 argument for making the highest-value notes
mobile-only, since photographed handwriting is exactly the content most worth
leaking and least protected on web.

## Consequences

- Image uploads need WebP conversion on ingest — phone photos are large, and
  Section 20.5 lists bandwidth as the top cost lever.
- Page ordering is now a teacher-facing concern. Photographed notes arrive as
  an unordered multi-file selection and need drag-to-reorder, the same control
  the module/lesson builder already needs.
- Watermarking must work over arbitrary photographed backgrounds, which vary
  far more than a rendered white page. Contrast of the overlay cannot be
  assumed.
