"use dom";

import { Component, type ReactNode, useEffect, useMemo, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { DOMProps } from "expo/dom";
import { splitPatch, type PatchFile } from "./diffPatch";

/**
 * The @pierre/diffs renderer, hosted in an Expo DOM component (a WebView that
 * Expo bundles react-dom into). Mobile-only — desktop resolves the platform
 * seam in DiffView.desktop.tsx and never imports this file.
 *
 * Renders each file as a GitHub-style section: accordion header (file icon,
 * path, +/- counts, a "Viewed" checkbox that collapses the file) above a
 * Pierre diff body. Props cross a serialization boundary, so only plain data
 * comes in; all interaction state lives here.
 */

// --- @crabnebula/file-icons, instantiated at runtime -------------------------
// The npm package imports its .wasm as an ES module, which Metro can't bundle.
// The WebView *can* run WebAssembly, so we fetch the same wasm from unpkg and
// port the package's ~20-line wrapper (dist/lib.js) around it verbatim.
const FILE_ICONS_VERSION = "0.1.0";
const FILE_ICONS_BASE = `https://unpkg.com/@crabnebula/file-icons@${FILE_ICONS_VERSION}`;
const ICON_ROOT = `${FILE_ICONS_BASE}/icons/`;
const WASM_URL = `${FILE_ICONS_BASE}/dist/file_icons-KM7ZT43I.wasm`;

interface FileIconsWasm {
  memory: WebAssembly.Memory;
  _get_icon_for_file: (retptr: number, ptr: number, len: number) => void;
}
let fileIconsWasm: FileIconsWasm | null = null;

async function loadFileIcons(): Promise<void> {
  // Buffer + instantiate (not instantiateStreaming): survives wrong MIME types
  // and older WebKit. Retry a few times — a transient CDN failure otherwise
  // leaves every file on the fallback glyph for the session.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`wasm fetch ${res.status}`);
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      fileIconsWasm = instance.exports as unknown as FileIconsWasm;
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function lookupIconForFile(path: string): string | null {
  const wasm = fileIconsWasm;
  if (!wasm) return null;
  try {
    const view = new Uint8Array(wasm.memory.buffer, 0, 1024);
    const { written } = new TextEncoder().encodeInto(path, view);
    const retptr = ((view.byteOffset + (written ?? 0)) | 15) + 1;
    wasm._get_icon_for_file(retptr, view.byteOffset, written ?? 0);
    const tag = new Int32Array(wasm.memory.buffer)[retptr / 4];
    const value = new BigInt64Array(wasm.memory.buffer)[retptr / 8 + 1];
    return tag === 0 ? null : `${ICON_ROOT}${BigInt.asUintN(64, value)}.svg`;
  } catch {
    return null;
  }
}

/** The 0.1.0 matcher misses some equivalents (.mjs/.cjs are JS, .mts/.cts are
 *  TS, lockfiles are JSON-ish) — retry misses under an aliased extension. */
const ICON_EXT_ALIASES: Record<string, string> = {
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  lock: "json",
};

function getIconForFile(path: string): string | null {
  const direct = lookupIconForFile(path);
  if (direct) return direct;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const alias = ICON_EXT_ALIASES[ext];
  return alias ? lookupIconForFile(`x.${alias}`) : null;
}

// --- theme tokens (mirrors the app's dark palette) ---------------------------
const C = {
  bg: "#0b0b0f",
  elevated: "#101016",
  border: "#26262e",
  fg: "#ececf1",
  fgMuted: "#9a9aa5",
  fgFaint: "#62626d",
  add: "#3fb950",
  del: "#f85149",
  accent: "#7c6ff0",
};

function FileSection({
  file,
  diffStyle,
  iconsReady,
  initialSeen,
  onToggleSeen,
}: {
  file: PatchFile;
  diffStyle: "unified" | "split";
  iconsReady: boolean;
  initialSeen: boolean;
  onToggleSeen?: (path: string, seen: boolean) => Promise<void> | void;
}) {
  // Seen files start collapsed — review progress persists on the RN side.
  const [viewed, setViewed] = useState(initialSeen);
  const [collapsed, setCollapsed] = useState(initialSeen);
  const icon = iconsReady ? getIconForFile(file.path) : null;

  const toggleViewed = () => {
    // GitHub behavior: marking seen collapses; unmarking expands.
    setViewed((v) => {
      setCollapsed(!v);
      void onToggleSeen?.(file.path, !v);
      return !v;
    });
  };

  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      <div
        onClick={() => setCollapsed((c) => !c)}
        style={{
          // Sticky on both axes: code hunks can overflow horizontally, and the
          // header must stay fully visible (incl. the Viewed control) anyway.
          position: "sticky",
          top: 0,
          left: 0,
          width: "100vw",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: C.elevated,
          borderTop: `1px solid ${C.border}`,
          cursor: "pointer",
          userSelect: "none",
          zIndex: 1,
        }}
      >
        {icon ? (
          <img
            src={icon}
            width={16}
            height={16}
            alt=""
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        ) : (
          <span style={{ width: 16, textAlign: "center", color: C.fgMuted, fontSize: 12 }}>📄</span>
        )}
        <span
          style={{
            flex: 1,
            fontFamily: "'JetBrainsMono', ui-monospace, Menlo, monospace",
            fontSize: 12,
            fontWeight: 600,
            color: viewed ? C.fgFaint : C.fg,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.path}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
          <span style={{ color: C.add }}>+{file.adds}</span>{" "}
          <span style={{ color: C.del }}>-{file.dels}</span>
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            toggleViewed();
          }}
          style={{ display: "flex", alignItems: "center", gap: 6, color: C.fgMuted, fontSize: 12 }}
        >
          Seen
          <span
            role="switch"
            aria-checked={viewed}
            style={{
              width: 34,
              height: 20,
              borderRadius: 10,
              background: viewed ? C.accent : "#3a3a44",
              position: "relative",
              display: "inline-block",
              transition: "background 0.15s ease",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: viewed ? 16 : 2,
                width: 16,
                height: 16,
                borderRadius: 8,
                background: "#fff",
                transition: "left 0.15s ease",
              }}
            />
          </span>
        </span>
      </div>
      {collapsed ? null : (
        <FileErrorBoundary fallback={<PlainPatch text={file.text} />}>
          <PatchDiff
            patch={file.text}
            options={{
              theme: { dark: "github-dark-default", light: "github-light-default" },
              themeType: "dark",
              diffStyle,
              disableFileHeader: true,
              overflow: "wrap",
            }}
          />
        </FileErrorBoundary>
      )}
    </div>
  );
}

/** One malformed file's patch must not take down the whole viewer — show the
 *  raw hunk text for that file instead. */
class FileErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Raw colored patch lines — fallback when Pierre rejects a file's hunks. */
function PlainPatch({ text }: { text: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: "8px 12px",
        fontFamily: "'JetBrainsMono', ui-monospace, Menlo, monospace",
        fontSize: 11,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        color: C.fgMuted,
      }}
    >
      {text
        .split("\n")
        .filter((l) => !/^(diff --git|index )/.test(l))
        .map((l, i) => (
          <div key={i} style={{ color: l.startsWith("+") ? C.add : l.startsWith("-") ? C.del : undefined }}>
            {l || " "}
          </div>
        ))}
    </pre>
  );
}

export default function PatchDiffDOM({
  patch,
  diffStyle = "unified",
  seenPaths = [],
  onToggleSeen,
  onReady,
}: {
  patch: string;
  diffStyle?: "unified" | "split";
  /** Files already marked Seen — start collapsed. */
  seenPaths?: string[];
  onToggleSeen?: (path: string, seen: boolean) => Promise<void>;
  /** Fired once react-dom has mounted — the RN side hides its skeleton then. */
  onReady?: () => Promise<void>;
  dom?: DOMProps;
}) {
  const files = useMemo(() => splitPatch(patch), [patch]);
  const [iconsReady, setIconsReady] = useState(false);
  useEffect(() => {
    void onReady?.();
    loadFileIcons().then(() => setIconsReady(true)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only signal
  }, []);

  return (
    <div
      style={
        {
          minHeight: "100vh",
          background: C.bg,
          // Match the app's mono font (JetBrainsMono, bundled on the RN side;
          // WKWebView runs out-of-process, so it loads its own copy below).
          "--diffs-font-family": "'JetBrainsMono', ui-monospace, Menlo, monospace",
          "--diffs-header-font-family": "'JetBrainsMono', ui-monospace, Menlo, monospace",
          "--diffs-font-size": "11px",
        } as React.CSSProperties
      }
    >
      <style>{`
        @font-face {
          font-family: 'JetBrainsMono';
          src: url('https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.woff2') format('woff2');
          font-weight: 400;
          font-display: swap;
        }
        @font-face {
          font-family: 'JetBrainsMono';
          src: url('https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-600-normal.woff2') format('woff2');
          font-weight: 600;
          font-display: swap;
        }
      `}</style>
      {files.map((f) => (
        <FileSection
          key={f.path}
          file={f}
          diffStyle={diffStyle}
          iconsReady={iconsReady}
          initialSeen={seenPaths.includes(f.path)}
          onToggleSeen={onToggleSeen}
        />
      ))}
    </div>
  );
}
