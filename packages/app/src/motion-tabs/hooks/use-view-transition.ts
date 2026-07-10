import { useState } from "react";

import type { INavItem, TMenuView } from "../typings/motion-tabs";
import { viewIndex } from "../utils/view-index";

function useViewTransition<T extends INavItem>(items: T[]) {
  const [view, setView] = useState<TMenuView>("default");
  const [panelDirection, setPanelDirection] = useState<number>(0);

  const setNextView = <T extends INavItem>(item: T) => {
    const nextView: TMenuView = view === item.key ? "default" : item.key;
    const nextDirection =
      view !== "default" && nextView !== "default" ?
        Math.sign(viewIndex(items, nextView) - viewIndex(items, view))
      : 0;

    setPanelDirection(nextDirection);
    setView(nextView);
  };

  const close = () => {
    setPanelDirection(0);
    setView("default");
  };

  return { close, panelDirection, setNextView, view };
}

export { useViewTransition };
