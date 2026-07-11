/**
 * Document attachment seam — desktop implementation. expo-document-picker has
 * no macOS/Windows build; report "canceled" so the Composer's attach flow
 * degrades quietly (an NSOpenPanel-backed picker is the follow-up).
 */
interface PickedDocument {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

export async function getDocumentAsync(_opts?: unknown): Promise<{
  canceled: boolean;
  assets: PickedDocument[] | null;
}> {
  return { canceled: true, assets: null };
}
