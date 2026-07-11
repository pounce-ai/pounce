import type { Route } from "@react-navigation/native";
import type { FC, FunctionComponent } from "react";

type TMenuView = "default" | string;
type TActiveView = string;

interface IPalette {
  accent: string;
  border: string;
  foreground: string;
  hover: string;
  input: string;
  muted: string;
  surface: string;
}

interface IPopupRenderContext {
  colors: IPalette;
  route: Route<string>;
  view: string;
  /** Dismiss the morphing popup panel (call after acting on an item). */
  close: () => void;
}

type TPopupRenderer = FC<IPopupRenderContext> &
  FunctionComponent<IPopupRenderContext>;

interface ISize {
  h: number;
  w: number;
}

interface ISizeMap {
  [view: string]: ISize | undefined;
}

export type {
  IPalette,
  IPopupRenderContext,
  ISizeMap,
  TActiveView,
  TMenuView,
  TPopupRenderer,
};
