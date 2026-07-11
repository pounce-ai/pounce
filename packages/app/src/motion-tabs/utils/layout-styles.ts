import { StyleSheet } from "react-native";

const layoutStyles = StyleSheet.create({
  card: {
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  cardShadow: {
    borderRadius: 28,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: "100%",
  },
  dock: {
    alignItems: "center",
    bottom: 0,
    left: 0,
    paddingTop: 8,
    position: "absolute",
    right: 0,
  },
  measure: {
    left: -10000,
    opacity: 0,
    position: "absolute",
    top: -10000,
  },
  panelArea: {
    flex: 1,
    overflow: "hidden",
    width: "100%",
  },
  panelLayer: {
    left: 0,
    position: "absolute",
    top: 0,
  },
  root: {
    overflow: "visible",
  },
  toolbarRow: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: 2,
    padding: 6,
  },
});

export { layoutStyles };
