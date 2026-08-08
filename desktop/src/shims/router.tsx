/**
 * expo-router shim for the desktop shell.
 *
 * The mobile screens navigate with `useRouter()` + string hrefs and read params
 * with `useLocalSearchParams()`. On desktop there is no router — a master-detail
 * shell renders the Home list as a persistent sidebar, the session view as the
 * main pane, and everything else as modal overlays. This module maps the same
 * href vocabulary onto that model so the screens can be reused unchanged.
 */
import { createContext, useContext, type ReactNode } from "react";
import { observable } from "@legendapp/state";

export interface Route {
  path: string;
  params: Record<string, string>;
}

type Href = string | { pathname: string; params?: Record<string, unknown> };

/** Hrefs that mean "go to the root list" (sidebar is always visible anyway). */
const HOME = new Set(["/", "/(app)", "/(app)/(tabs)", "/(app)/(tabs)/", "/index"]);

function parse(href: Href): Route {
  if (typeof href !== "string") {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(href.params ?? {})) params[k] = String(v);
    return { path: href.pathname, params };
  }
  const [rawPath, rawQuery] = href.split("?");
  const params: Record<string, string> = {};
  if (rawQuery) {
    for (const pair of rawQuery.split("&")) {
      const [k, v] = pair.split("=");
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  // Dynamic segment used by the app: /session/[id]
  const session = rawPath.match(/^\/session\/(.+)$/);
  if (session) {
    return { path: "/session", params: { ...params, id: decodeURIComponent(session[1]) } };
  }
  return { path: rawPath, params };
}

/**
 * Hrefs that open as a full PANE (their own tab) rather than a modal card.
 *
 * A modal is for something you do and dismiss. These are places you sit in and
 * come back to — a Space is a project's whole history and its instruction
 * files, which is reading and editing, not a dialog. They get a tab so they can
 * live beside the sessions you're switching between.
 *
 * Settings belongs here for the same reason: it is a list of machines you read
 * down, rename, resync and share from, not a question with an answer. As a card
 * it was a 620×660 box that clipped its own content and had to be dismissed
 * before you could look at anything it referred to.
 */
const PANES = new Set(["/space", "/metric", "/settings"]);

/**
 * Identity of an open tab: what makes two hrefs "the same thing already open".
 *
 * A session is its thread, so two threads get two tabs. A Space is just its
 * PATH — deliberately not its key — because you are only ever in one space at
 * a time: it IS the filter the sidebar is applying, so choosing another
 * replaces it rather than stacking a second. Threads are documents you
 * collect; a space is where you currently are.
 */
export function tabKey(r: Route): string {
  if (r.path === "/session") return `session:${r.params.id}`;
  return r.path;
}

/**
 * Identity of the rendered SCREEN, which is finer-grained than its tab's.
 *
 * The Space tab keeps one identity while its `key` changes underneath it, so
 * the screen has to remount on that change — otherwise you'd be reading one
 * project's numbers under another project's name.
 */
export function screenKey(r: Route): string {
  // Every pane is "one tab, whose contents swap": a Space tab keeps its
  // identity while `key` changes underneath it, and so does a Metric tab. The
  // screen therefore has to remount on that change, or you read one project's
  // (or one metric's) numbers under another's title. One rule for all panes
  // rather than a branch per path — a new pane gets this by joining PANES.
  if (PANES.has(r.path)) return `${r.path}:${r.params.key ?? ""}`;
  return tabKey(r);
}

/**
 * Desktop navigation state.
 *
 * `tabs` is the open set of sessions and panes, and `detail` is always
 * `tabs[active]` (or null when nothing is open) — screens keep reading
 * `detail`, the tab strip drives the rest. `dock` is the right-hand Changes
 * pane, which on desktop replaces the /changes modal: it's a companion to the
 * session you're reading, not something you dismiss to get back to work.
 */
export const nav$ = observable<{
  tabs: Route[];
  active: number;
  detail: Route | null;
  modal: Route | null;
  dock: boolean;
  sidebar: boolean;
  /**
   * The space you're working in — ONE fact serving two surfaces.
   *
   * It narrows the sidebar's session list and it decides what the Space tab
   * shows. Those are the same statement ("I'm in this project"), so they read
   * the same value: a local `useState` in the sidebar could drift out of step
   * with the tab the moment either side changed alone.
   */
  space: string | null;
}>({
  tabs: [],
  active: 0,
  detail: null,
  modal: null,
  dock: false,
  sidebar: true,
  space: null,
});

/** Re-derive `detail` from the tab list — the single place that keeps the two
 *  in sync, so no caller has to remember to set both. */
function syncDetail(): void {
  const tabs = nav$.tabs.get();
  const active = Math.min(nav$.active.get(), tabs.length - 1);
  nav$.active.set(Math.max(0, active));
  nav$.detail.set(tabs[active] ?? null);
}

/** Open a session or pane: focus its existing tab if it has one, else append. */
export function openTab(route: Route): void {
  const tabs = nav$.tabs.get();
  const key = tabKey(route);
  const at = tabs.findIndex((t) => tabKey(t) === key);
  if (at >= 0) {
    // Re-navigating to an open tab can carry new params (a search deep-link's
    // anchor, say) — replace it so the screen picks them up.
    nav$.tabs[at].set(route);
    nav$.active.set(at);
  } else {
    nav$.tabs.set([...tabs, route]);
    nav$.active.set(tabs.length);
  }
  syncDetail();
}

export function selectTab(index: number): void {
  nav$.active.set(index);
  syncDetail();
}

/**
 * Enter a space, or leave it (`null`).
 *
 * One click, one meaning: picking a space in the sidebar narrows the session
 * list AND opens that space's page, because those were never two intentions.
 * (There used to be a separate eye button for the second half — a control for
 * a selection the row click had already made.) Leaving closes the page again,
 * so the sidebar can't sit filtered by a space with nothing on screen.
 */
export function selectSpace(key: string | null): void {
  nav$.space.set(key);
  if (key) {
    openTab({ path: "/space", params: { key } });
    return;
  }
  const at = nav$.tabs.get().findIndex((t) => t.path === "/space");
  if (at >= 0) closeTab(at);
}

export function closeTab(index: number): void {
  const tabs = nav$.tabs.get();
  // Closing the Space tab is the other way of saying "I'm done with this
  // project", so it leaves the space too — otherwise the sidebar stays
  // filtered to a space whose page is gone, with no obvious way back.
  if (tabs[index]?.path === "/space") nav$.space.set(null);
  nav$.tabs.set(tabs.filter((_, i) => i !== index));
  // Closing a tab left of (or at) the active one shifts the selection left, so
  // the neighbour you were looking at stays focused rather than jumping.
  if (index <= nav$.active.get()) nav$.active.set(Math.max(0, nav$.active.get() - 1));
  syncDetail();
}

function go(href: Href): void {
  const r = parse(href);
  if (HOME.has(r.path)) {
    nav$.modal.set(null);
    return;
  }
  if (r.path === "/session" || PANES.has(r.path)) {
    nav$.modal.set(null);
    openTab(r);
    return;
  }
  // Changes is a docked pane on desktop, not a modal — it always describes the
  // open session, so it opens beside the transcript instead of covering it.
  // The pane renders the active tab, so focus the requested thread first rather
  // than silently showing a different thread's diff.
  if (r.path === "/changes") {
    nav$.modal.set(null);
    if (r.params.id) openTab({ path: "/session", params: { id: r.params.id } });
    nav$.dock.set(true);
    return;
  }
  nav$.modal.set(r);
}

export const router = {
  push: (href: Href) => go(href),
  navigate: (href: Href) => go(href),
  replace: (href: Href) => go(href),
  // Peel the shell back one layer at a time — modal, then the docked pane,
  // then the open tab — so a screen's own back button never blows away more
  // context than the user can see.
  back: () => {
    if (nav$.modal.get()) nav$.modal.set(null);
    else if (nav$.dock.get()) nav$.dock.set(false);
    else if (nav$.tabs.get().length) closeTab(nav$.active.get());
  },
  dismiss: () => nav$.modal.set(null),
  canGoBack: () => !!(nav$.modal.get() || nav$.dock.get() || nav$.tabs.get().length),
};

export function useRouter() {
  return router;
}

const ParamsContext = createContext<Record<string, string>>({});

/** The shell wraps each rendered screen with its route's params. */
export function RouteParamsProvider({
  params,
  children,
}: {
  params: Record<string, string>;
  children: ReactNode;
}) {
  return <ParamsContext.Provider value={params}>{children}</ParamsContext.Provider>;
}

export function useLocalSearchParams<
  T extends Record<string, string> = Record<string, string>,
>(): T {
  return useContext(ParamsContext) as T;
}

export const useGlobalSearchParams = useLocalSearchParams;

/** Layout components — unused by the desktop shell, kept for API compatibility. */
function Noop(_props: Record<string, unknown>) {
  return null;
}
export const Stack = Object.assign(Noop, { Screen: Noop });
export const Tabs = Object.assign(Noop, { Screen: Noop });
export const Link = Noop;
