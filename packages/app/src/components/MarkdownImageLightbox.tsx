/**
 * Lightbox for images embedded in markdown — native no-op.
 *
 * On native the markdown engine draws images itself and attachments already
 * have their own tap-to-preview (Timeline's InlineImages); there is nothing to
 * mount here. The web variant (MarkdownImageLightbox.web.tsx) is the real one:
 * the web markdown renderer emits plain <img> tags with no press callback, so
 * the lightbox hangs off DOM event delegation instead — and it also owns the
 * CSS that stops those images rendering skewed.
 */
export function MarkdownImageLightbox(): null {
  return null;
}
