/**
 * Spaces live in the shared package now — both apps derive them the same way.
 * Kept as a re-export so the shell's imports stay put.
 */
export { deriveSpaces, spaceKeyFor, spaceKeyOf, type Space } from "@pounce/app/state/spaces";
