// The iOS app runs this same build inside a WKWebView (Capacitor). There, an
// <a download> click does nothing, so finished files are written into the
// app's Documents folder instead (visible in Files › On My iPhone/iPad ›
// HackerPDF) and the share sheet opens, so they can go straight to Save to
// Files, Mail, AirDrop and so on. Nothing here runs on the website.

import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();

if (isNative) document.documentElement.classList.add("native");

/** Blob -> base64 without building a giant string by hand. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

/** Characters the iOS file system or the share sheet don't like. */
function safeName(name: string): string {
  return name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").trim() || "document";
}

/** "Report.pdf" -> "Report (2).pdf" until the name is free. */
async function freeName(name: string): Promise<string> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    try {
      await Filesystem.stat({ path: candidate, directory: Directory.Documents });
    } catch {
      return candidate; // doesn't exist yet
    }
  }
  return `${stem} ${Date.now()}${ext}`;
}

/**
 * Save a finished file on iOS: write it to Documents, then offer the share
 * sheet. Cancelling the sheet is fine; the file is already saved.
 */
export async function saveNative(blob: Blob, name: string): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  const path = await freeName(safeName(name));
  const { uri } = await Filesystem.writeFile({
    path,
    data: await toBase64(blob),
    directory: Directory.Documents,
  });
  try {
    await Share.share({ title: path, files: [uri] });
  } catch {
    // Share sheet dismissed: nothing to do.
  }
}
