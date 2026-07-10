/**
 * Image attachment seam — desktop implementation. expo-image-picker has no
 * macOS/Windows build; the Composer already handles the permission-denied
 * path with a friendly alert, so report not-granted instead of crashing.
 */
interface PickedAsset {
  uri: string;
  base64?: string;
  mimeType?: string;
}

export async function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: false };
}

export async function launchImageLibraryAsync(_opts?: unknown): Promise<{
  canceled: boolean;
  assets: PickedAsset[];
}> {
  return { canceled: true, assets: [] };
}

export const MediaTypeOptions = { Images: "images" } as const;
