// Opens a quote, invoice or receipt PDF in a new tab. The tab opens straight
// away (a tab opened after waiting is blocked as a popup) and shows the PDF
// once it's made; if the server refuses, the tab closes and the reason comes
// back to the caller instead of a page of raw JSON.
import { api } from "./api";

export async function openDocumentPdf(url: string, onError: (message: string) => void) {
  const tab = window.open("", "_blank");
  if (tab) {
    tab.document.title = "Preparing PDF…";
    tab.document.body.style.cssText = "font: 14px system-ui, sans-serif; color: #666; padding: 24px";
    tab.document.body.textContent = "Preparing PDF…";
  }
  try {
    const pdf = await api.documentPdf(url);
    const objectUrl = URL.createObjectURL(pdf);
    if (tab) tab.location.href = objectUrl;
    else window.location.assign(objectUrl);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    tab?.close();
    onError(err instanceof Error ? err.message : "The PDF couldn't be made. Try again.");
  }
}
