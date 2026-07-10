import { StyleSheet } from "react-native";

const popupBodyStyles = StyleSheet.create({
  chip: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  menuPad: {
    gap: 2,
    padding: 8,
  },
  menuRow: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  menuText: {
    fontSize: 15,
  },
  searchInput: {
    alignItems: "center",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  searchRow: {
    flexDirection: "row",
    gap: 6,
  },
  searchText: {
    flex: 1,
    fontSize: 14.5,
    padding: 0,
  },
});

export { popupBodyStyles };
