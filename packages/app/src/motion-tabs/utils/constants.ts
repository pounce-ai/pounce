import {
  Easing,
  type EasingFunctionFactory as IEasingFunction,
} from "react-native-reanimated";

const HOME_ITEMS = [
  { icon: "note", text: "Note" },
  { icon: "voice", text: "Voice" },
  { icon: "screenshot", text: "Screenshot" },
] as const;

const SEARCH_OPTIONS = [
  { icon: "filter", text: "Filter" },
  { icon: "trending", text: "Trending" },
] as const;

const NOTIFICATION_ITEMS = [
  { icon: "messages", text: "Messages" },
  { icon: "alerts", text: "System Alerts" },
] as const;

const EASING: IEasingFunction = Easing.bezier(0.22, 1, 0.36, 1);
const DURATION: number = 600;
const ICON_BOX: number = 48;
const LABEL_PAD: number = 18;
const PANEL_SLIDE: number = 65;
const TAB_HEIGHT: number = 44;

export {
  DURATION,
  EASING,
  HOME_ITEMS,
  ICON_BOX,
  LABEL_PAD,
  NOTIFICATION_ITEMS,
  PANEL_SLIDE,
  SEARCH_OPTIONS,
  TAB_HEIGHT,
};
