/**
 * File-naming check for the app sources.
 *
 * The convention, which existed but was never written down or enforced — so it
 * drifted:
 *
 *   PascalCase   a module whose job is to export React components.
 *                Composer.tsx, StatTile.tsx, ActivityBones.tsx
 *
 *   camelCase    everything else — utilities, state, services, and the
 *                platform SEAMS that stand in for a library rather than for a
 *                component (enrichedInput.ts, animation.ts, contextSections.ts).
 *
 *   lowercase    expo-router route files under apps/mobile/app. The filename IS
 *                the URL segment, so these are named by the router, not by us.
 *
 * Platform variants keep their base name's case (Skeleton.macos.tsx), because
 * Metro picks them by that base.
 *
 * Two extra reasons this matters beyond tidiness. Git on macOS is
 * case-insensitive (`core.ignorecase=true`), so a case-only rename needs a
 * two-step `git mv` through a temp name or it silently does nothing — the mess
 * is much cheaper to prevent than to undo. And a wrong-case import resolves
 * fine on macOS while failing on Linux CI, so drift here surfaces as a build
 * that only breaks in CI.
 *
 * Usage: node scripts/check-naming.mjs   (exit 1 on violations)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["packages/app/src", "desktop/src"];
/** Router-owned trees: the filename is a URL, so our casing rules don't apply. */
const ROUTER_TREES = ["apps/mobile/app"];

/** Strip a platform/variant suffix: `Skeleton.macos.tsx` → `Skeleton`. */
function baseName(file) {
  return file
    .replace(/\.(ios|android|macos|windows|desktop|native|web|types|test|spec)\./, ".")
    .replace(/\.tsx?$/, "");
}

/**
 * Is this file NAMED AFTER a component it exports?
 *
 * The one thing a script can judge without guessing. `activityBones.tsx`
 * exporting `ActivityBones` is unambiguously a component module wearing the
 * wrong case. Whereas `animation.desktop.tsx` exports `Animated`, and
 * `localBridge.ts` exports services — neither is named after a component, and
 * both are camelCase on purpose.
 *
 * An earlier version asked the broader question ("does this export ANY
 * component?") and flagged nine correct files: every seam that stands in for a
 * library, every barrel, every service that happens to render something. A
 * check that cries wolf gets switched off, so this one only speaks when it is
 * certain.
 */
function namedAfterAComponent(src, base) {
  const pascal = base[0].toUpperCase() + base.slice(1);
  const decl = new RegExp(`export\\s+(default\\s+)?(function|const)\\s+${pascal}\\b`);
  return decl.test(src);
}

/** A file that only re-exports another module is named after what it forwards. */
function isReExportOnly(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^export\s+(\*|\{|type\s)/.test(l));
}

const problems = [];

function walk(dir, { router }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, { router });
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const base = baseName(entry.name);
    const src = readFileSync(full, "utf8");

    if (router) {
      // expo-router: lowercase, with `_layout` and `[param]` as its own idioms.
      if (/[A-Z]/.test(base.replace(/\[|\]/g, ""))) {
        problems.push([full, `route files are lowercase (the filename is the URL): ${base}`]);
      }
      continue;
    }

    const pascal = /^[A-Z]/.test(base);
    if (isReExportOnly(src)) continue; // named after what it forwards

    if (!pascal && namedAfterAComponent(src, base)) {
      const want = base[0].toUpperCase() + base.slice(1);
      problems.push([full, `exports the component \`${want}\` — the file should be ${want}${path.extname(entry.name)}`]);
    }
  }
}

for (const r of ROOTS) {
  try {
    if (statSync(r).isDirectory()) walk(r, { router: false });
  } catch {
    /* root absent in this checkout */
  }
}
for (const r of ROUTER_TREES) {
  try {
    if (statSync(r).isDirectory()) walk(r, { router: true });
  } catch {
    /* absent */
  }
}

if (problems.length) {
  console.error("File naming violations:\n");
  for (const [file, why] of problems) console.error(`  ${file}\n    ${why}\n`);
  console.error(
    "Renaming on macOS needs two steps, or git records nothing:\n" +
      "  git mv Foo.tsx tmp && git mv tmp FooBar.tsx\n",
  );
  process.exit(1);
}
console.log("File naming OK.");
