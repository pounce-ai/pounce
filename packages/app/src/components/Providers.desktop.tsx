/**
 * Providers — desktop variant. Gesture-handler, keyboard-controller and HeroUI
 * are mobile-only; desktop needs just safe-area (screens read insets) + query.
 */
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../services/queryClient";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SafeAreaProvider>
  );
}
