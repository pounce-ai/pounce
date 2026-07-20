import { observable } from "@legendapp/state";

/** Search-tab query. On mobile the native UISearchBar in the navigation bar
 *  writes here (see apps/mobile app/(app)/(tabs)/search/_layout.tsx); the
 *  shared Search screen reads it. Desktop keeps its in-screen TextInput. */
export const searchQuery$ = observable("");
