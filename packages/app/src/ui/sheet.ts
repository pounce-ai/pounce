/**
 * The pending action-sheet request, on Android.
 *
 * `pickSheet` is imperative — it's called from a long-press handler, not
 * rendered — and the two platforms that had an answer for that both provide one
 * natively: ActionSheetIOS on iOS, NSAlert buttons on desktop. Android has
 * neither, so every menu routed through ActionSheetIOS was a no-op there:
 * favouriting a thread, adding a marker, attaching a file. The press worked,
 * the sheet never came.
 *
 * Alert.alert isn't the fix — Android caps it at three buttons and the
 * Composer's attachment list is longer than that. So the imperative call parks
 * a request here and components/SheetHost.tsx draws it through the same real
 * BottomSheetDialog the rest of the app's sheets use.
 *
 * STORE ONLY, no component: `ui/index.tsx` is imported by nearly every file in
 * the app, and pulling a component graph into it from there would be a cycle
 * waiting to happen (components import from ../ui constantly).
 */
import { observable } from "@legendapp/state";

export interface SheetRequest {
  readonly title?: string;
  readonly labels: readonly string[];
  /** Called with -1 when the sheet is dismissed without a choice. */
  readonly onPick: (index: number) => void;
}

/** What the host DRAWS. Just the text — see `pending` for why. */
interface SheetView {
  readonly title?: string;
  readonly labels: readonly string[];
}

/**
 * ONE request at a time, and a second `openSheet` replaces the first: two
 * stacked system sheets is not a state Android recovers from gracefully, and a
 * user who long-presses twice means the second one.
 */
export const sheetView$ = observable<SheetView | null>(null);

/**
 * The live callback, held OUTSIDE the observable.
 *
 * Legend State treats a function stored in an observable as a computed value —
 * reading the node would invoke it rather than hand it back — so the handler
 * has to live beside the store rather than in it. Kept in lockstep with
 * `sheetView$`: both are set by `openSheet` and both are cleared by `takePick`.
 */
let pending: ((index: number) => void) | null = null;

/** Park a menu for the host to draw. Android only — see `pickSheet`. */
export function openSheet(req: SheetRequest): void {
  pending = req.onPick;
  sheetView$.set({ title: req.title, labels: req.labels });
}

/**
 * Close the sheet and report the choice (-1 for a dismissal).
 *
 * Reads and clears in one step so a double-dismiss — Android can fire its
 * dismissal callback after the row press has already closed the sheet — reports
 * once and not twice.
 */
export function takePick(index: number): void {
  const onPick = pending;
  pending = null;
  sheetView$.set(null);
  onPick?.(index);
}
