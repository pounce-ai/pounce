import type { ReactNode } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { HeroUINativeProvider } from "heroui-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../services/queryClient";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <HeroUINativeProvider>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
          </HeroUINativeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
