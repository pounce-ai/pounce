/**
 * Lightbox for markdown-embedded images — web implementation, mounted once by
 * the web shell. The markdown web renderer emits plain <img> tags with a
 * forced inline height (skews wide images) and no press callback, so both
 * fixes live at the DOM layer, keyed off its stable `enrm-text` container
 * class: a stylesheet whose `height: auto !important` beats the inline style,
 * and one document-level click listener that covers the settled AND streaming
 * renderers without threading props through either. Wheel zooms about the
 * cursor, drag pans, double-click toggles, Esc / backdrop / ✕ close.
 */
import { useEffect, useRef, useState } from "react";

const ENRM_CLASS = "enrm-text"; // react-native-enriched-markdown's container class

const CSS = `.${ENRM_CLASS} img { height: auto !important; max-width: 100%; cursor: zoom-in; }`;

const MAX_SCALE = 8;
const MIN_SCALE = 1;

interface ViewState {
  scale: number;
  tx: number;
  ty: number;
}

const RESET: ViewState = { scale: 1, tx: 0, ty: 0 };

export function MarkdownImageLightbox() {
  const [src, setSrc] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(RESET);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // The click delegation lives for the app's lifetime.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.tagName !== "IMG" || !t.closest(`.${ENRM_CLASS}`)) return;
      e.preventDefault();
      e.stopPropagation();
      setView(RESET);
      setSrc((t as HTMLImageElement).src);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSrc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src]);

  if (!src) return <style>{CSS}</style>;

  /** Zoom about a viewport point so the pixel under the cursor stays put. */
  const zoomAt = (cx: number, cy: number, nextScale: number) => {
    setView((v) => {
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
      if (s === v.scale) return v;
      const px = cx - window.innerWidth / 2;
      const py = cy - window.innerHeight / 2;
      const k = s / v.scale;
      const tx = px - (px - v.tx) * k;
      const ty = py - (py - v.ty) * k;
      return s === 1 ? RESET : { scale: s, tx, ty };
    });
  };

  return (
    <>
      <style>{CSS}</style>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 10_000,
          background: "rgba(8, 8, 10, 0.88)",
          overscrollBehavior: "contain",
          cursor: view.scale > 1 ? "grab" : "zoom-out",
          userSelect: "none",
        }}
        onClick={(e) => {
          // Backdrop only — clicks on the image itself belong to zoom/pan.
          if (e.target === e.currentTarget) setSrc(null);
        }}
        onWheel={(e) => {
          e.preventDefault();
          zoomAt(e.clientX, e.clientY, view.scale * Math.exp(-e.deltaY * 0.0022));
        }}
        onPointerDown={(e) => {
          if (view.scale <= 1) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onDoubleClick={(e) => {
          zoomAt(e.clientX, e.clientY, view.scale > 1 ? 1 : 2.5);
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            margin: "auto",
            maxWidth: "94vw",
            maxHeight: "94vh",
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transition: drag.current ? undefined : "transform 120ms ease-out",
            borderRadius: 6,
          }}
        />
        <button
          aria-label="Close"
          onClick={() => setSrc(null)}
          style={{
            position: "fixed",
            top: 14,
            right: 16,
            width: 32,
            height: 32,
            borderRadius: 16,
            border: "none",
            background: "rgba(255,255,255,0.12)",
            color: "#fff",
            fontSize: 16,
            lineHeight: "32px",
            textAlign: "center",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>
    </>
  );
}
