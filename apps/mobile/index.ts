/**
 * Entry: a bare dispatch to the platform boot sequence. Expo resolves the
 * package.json "main" path literally — no .web/.ios suffixes — but Metro DOES
 * platform-resolve every import, so "./boot" is where native (boot.ts) and
 * web (boot.web.ts — the desktop Shell, no expo-router) diverge.
 */
import "./boot";
