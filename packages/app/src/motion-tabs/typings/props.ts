import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import type { Route } from "@react-navigation/native";
import type { ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { IPalette, ISizeMap, TMenuView, TPopupRenderer } from "./base";

interface INavItem {
  icon: <T extends boolean>(
    focused: T,
    color: string,
    size: number,
  ) => ReactNode;
  key: string;
  label: string;
  route: Route<string>;
  routeName: string;
}

interface IAnimatedTabBarProps extends BottomTabBarProps {
  renderPopupBody?: TPopupRenderer;
  /** Force a tab's popup open by its route key (overrides user interaction).
   *  Used by the guided tour to demonstrate the quick-actions menu. */
  forcedView?: string | null;
}

interface IMorphTabProps {
  active: boolean;
  colors: IPalette;
  item: INavItem;
  onPress: () => void;
}

interface IPanelLayerProps {
  active: boolean;
  close: () => void;
  colors: IPalette;
  direction: number;
  onLayout: (view: string, width: number, height: number) => void;
  renderPopupBody: TPopupRenderer;
  route: Route<string>;
  view: string;
}

interface IPanelStackProps {
  close: () => void;
  colors: IPalette;
  direction: number;
  items: INavItem[];
  onMeasure: (view: string, width: number, height: number) => void;
  renderPopupBody: TPopupRenderer;
  view: TMenuView;
}

interface IMeasurementLayerProps {
  colors: IPalette;
  items: INavItem[];
  onMeasure: (view: string, width: number, height: number) => void;
  renderPopupBody: TPopupRenderer;
}

interface ITabToolbarProps {
  colors: IPalette;
  items: INavItem[];
  onLayout: (event: LayoutChangeEvent) => void;
  onPress: (item: INavItem, index: number) => void;
  view: TMenuView;
}

interface ICardMorphOptions {
  sizes: ISizeMap;
  toolbarH: number;
  toolbarMinW: number;
  toolbarW: number;
  view: TMenuView;
}

interface IProfileAccordionItemProps {
  body: string;
  colors: IPalette;
  subtitle: string;
  title: string;
  value: string;
}

export type {
  IAnimatedTabBarProps,
  ICardMorphOptions,
  IMeasurementLayerProps,
  IMorphTabProps,
  INavItem,
  IPanelLayerProps,
  IPanelStackProps,
  IProfileAccordionItemProps,
  ITabToolbarProps,
};
