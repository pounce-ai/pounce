// Web mounts the desktop Shell (apps/mobile/WebApp.tsx), whose tab strip and
// status bar read sessionChrome$ — so web takes the desktop implementation,
// not the mobile useState one.
export * from "./sessionChrome.desktop";
