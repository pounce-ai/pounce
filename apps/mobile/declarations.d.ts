// Fresh checkouts lack the generated expo-env.d.ts (gitignored), which is what
// normally declares CSS side-effect imports — keep typecheck green without it.
declare module "*.css";
