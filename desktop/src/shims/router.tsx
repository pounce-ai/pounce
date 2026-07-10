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

/** Desktop navigation state: main pane (session) + modal overlay. */
export const nav$ = observable<{ detail: Route | null; modal: Route | null }>({
  detail: null,
  modal: null,
});

function go(href: Href): void {
  const r = parse(href);
  if (HOME.has(r.path)) {
    nav$.set({ detail: null, modal: null });
    return;
  }
  if (r.path === "/session") {
    nav$.set({ detail: r, modal: null });
    return;
  }
  nav$.modal.set(r);
}

export const router = {
  push: (href: Href) => go(href),
  navigate: (href: Href) => go(href),
  replace: (href: Href) => go(href),
  back: () => {
    if (nav$.modal.get()) nav$.modal.set(null);
    else nav$.detail.set(null);
  },
  dismiss: () => nav$.modal.set(null),
  canGoBack: () => !!(nav$.modal.get() || nav$.detail.get()),
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
