/**
 * Streaming POST seam — desktop implementation.
 *
 * react-native-nitro-fetch has no macOS/Windows build, and RN's fetch can't
 * expose `response.body` — but RN's XHR delivers incremental `onprogress`
 * events with a growing responseText, which is all SSE needs.
 */
export function streamTurn(
  url: string,
  opts: { headers: Record<string, string>; body: string },
  onChunk: (text: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    const drain = () => {
      const text = xhr.responseText ?? "";
      if (text.length > seen) {
        onChunk(text.slice(seen));
        seen = text.length;
      }
    };
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(opts.headers)) xhr.setRequestHeader(k, v);
    xhr.onprogress = drain;
    xhr.onerror = () => reject(new Error("turn failed: network error"));
    xhr.onload = () => {
      drain();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`turn failed: ${xhr.status}`));
    };
    xhr.send(opts.body);
  });
}
