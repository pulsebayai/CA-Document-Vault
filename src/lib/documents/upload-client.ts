// Browser-side upload to a signed Storage URL (spec 03 architecture change 1). A raw PUT with our canonical
// Content-Type, so the stored type matches the extension (a FormData upload would store the browser's own type).
/** Headers of the raw PUT. `private, no-store`: Storage serves this as the file's Cache-Control, so no browser or
 *  proxy keeps document bytes after the ≤ 60 s link expires (architecture: no document bytes cached). */
export const UPLOAD_HEADERS = { "x-upsert": "false", "cache-control": "private, no-store" } as const;

export function putFile(url: string, file: File, contentType: string, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", contentType);
    for (const [k, v] of Object.entries(UPLOAD_HEADERS)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(String(xhr.status))));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(file);
  });
}
