import { useState } from "react";
import type { LayoutChangeEvent } from "react-native";

import type { ISizeMap } from "../typings/motion-tabs";

function useDynamicLayout() {
  const [sizes, setSizes] = useState<ISizeMap>({});
  const [toolbarMinW, setToolbarMinW] = useState<number>(0);
  const [toolbarW, setToolbarW] = useState<number>(0);
  const [toolbarH, setToolbarH] = useState<number>(0);

  const handleMeasure = (view: string, w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    setSizes((current) => {
      const existing = current[view];
      if (existing?.w === w && existing.h === h) return current;
      return { ...current, [view]: { w, h } };
    });
  };

  const handleToolbarLayout = (event: LayoutChangeEvent) => {
    const w = Math.ceil(event.nativeEvent.layout.width);
    const h = Math.ceil(event.nativeEvent.layout.height);
    if (toolbarMinW === 0 && w > 0) setToolbarMinW(w);
    if (w > 0 && w !== toolbarW) setToolbarW(w);
    if (h > 0 && h !== toolbarH) setToolbarH(h);
  };

  return {
    handleMeasure,
    handleToolbarLayout,
    sizes,
    toolbarH,
    toolbarMinW,
    toolbarW,
  };
}

export { useDynamicLayout };
