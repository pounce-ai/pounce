import { useMemo } from "react";

import type { IAnimatedTabBarProps, INavItem } from "../typings/motion-tabs";

function useNavItems({
  descriptors,
  state,
}: Pick<IAnimatedTabBarProps, "descriptors" | "state">) {
  return useMemo<INavItem[]>(
    () =>
      state.routes
        .map((route) => {
          const options = descriptors[route.key]?.options;
          if ((options as { href?: unknown })?.href === null) return null;
          const label =
            typeof options?.tabBarLabel === "string" ?
              options.tabBarLabel
            : (options?.title ?? route.name);

          const item: INavItem = {
            icon: (focused, color, size) =>
              options?.tabBarIcon?.({ focused, color, size }) ?? null,
            key: route.key,
            label,
            route,
            routeName: route.name,
          };

          return item;
        })
        .filter((item): item is INavItem => item !== null),
    [descriptors, state.routes],
  );
}

export { useNavItems };
