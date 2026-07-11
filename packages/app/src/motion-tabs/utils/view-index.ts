import type { INavItem } from "../typings/motion-tabs";

function viewIndex(items: INavItem[], view: string) {
  return items.findIndex((item) => item.key === view);
}

export { viewIndex };
