/** What kind of document a file is, for Word to PDF. Kept apart so the app can check without loading the converter. */

export type Kind = "docx" | "markdown" | "text";

export class UnsupportedFile extends Error {}

export function documentKind(file: File): Kind | null {
  const n = file.name.toLowerCase();
  if (n.endsWith(".docx") || n.endsWith(".docm") || n.endsWith(".dotx")) return "docx";
  if (/\.(md|markdown|mdown|mkd)$/.test(n)) return "markdown";
  if (n.endsWith(".txt") || n.endsWith(".text") || n.endsWith(".log") || n.endsWith(".csv")) return "text";
  if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (file.type === "text/markdown") return "markdown";
  if (file.type === "text/plain") return "text";
  return null;
}

/** Why a file can't be converted, in words for the person. */
export function unsupportedReason(file: File): string {
  const n = file.name.toLowerCase();
  if (n.endsWith(".doc")) return "Old Word files (.doc) aren't supported. Open it in Word and save it as .docx first.";
  if (n.endsWith(".odt")) return "OpenDocument files (.odt) aren't supported. Save it as .docx first.";
  if (n.endsWith(".rtf")) return "RTF files aren't supported. Save it as .docx first.";
  if (n.endsWith(".pages")) return "Pages files aren't supported. In Pages, export it as Word (.docx) first.";
  return "Choose a Word (.docx), Markdown (.md) or text (.txt) file.";
}
