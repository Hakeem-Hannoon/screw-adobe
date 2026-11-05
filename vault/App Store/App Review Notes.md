---
tags: [app-store, review]
---

# App Review Notes

[[Home]] · [[App Store/App Store Connect Answers|Answers]]

## Paste into "Notes" (App Review Information)

```
HackerPDF is a free, offline PDF toolkit for iPhone and iPad. There is no account, sign-in, payment, advertising or data collection, so no demo account is needed.

All processing happens on the device. The app contains everything it needs (PDF engine, OCR model, fonts) and makes no network requests; it works in Airplane Mode.

How to test (a sample PDF is attached; any PDF in Files also works):
1. Tap Redact and choose the sample PDF.
2. Tap the magnifier, tap "Phone numbers", then "Black out all". Or drag on the page to draw a black box.
3. Tap the download arrow. The file is saved to Files > On My iPhone > HackerPDF, and the share sheet opens.
4. Open the saved file: the covered text is removed from the file, not just hidden.
5. From the start screen, try Sign, Merge, Split, Organize pages, Rotate, Compress, Page numbers, Compare, Make searchable (on-device OCR), and "PDF to ?" for PDF/Word/image/text conversions.

The interface is built with web technologies inside the app bundle (Capacitor), and the same tools are also available free at hakeem-hannoon.github.io/screw-adobe. The app adds offline use, saving into the Files app, the system share sheet and file pickers, and full iPhone and iPad layouts.

Encryption: the app only decrypts password-protected PDFs that the user opens (exempt, Category 5 Part 2, decryption of data or files). ITSAppUsesNonExemptEncryption is set to NO.
```

## Attachment

Upload `Attachments/App Store/Review sample - Tenancy Confirmation.pdf` in the **Attachment** field. It's a fictional two-page letter with names, an email, phone numbers and an account number to cover.

## Likely questions and answers

**Guideline 4.2 (Minimum Functionality) — "your app is a repackaged website".**
Reply that the app is a complete set of 15 document tools that run entirely on the device and offline, bundled in the app rather than loaded from a website. It integrates with the Files app (saved documents appear under On My iPhone › HackerPDF), the share sheet and the system document and photo pickers, and is laid out for iPhone and iPad. Point to OCR, Word conversion and redaction as substantial on-device features. If needed, the 1.1 roadmap item "Open in HackerPDF" from other apps (see [[iOS App#Decisions]]) adds more native integration.

**Guideline 2.1 (App Completeness) — "we couldn't find a PDF".**
Point to the attached sample and ask the reviewer to save it to Files first.

**Guideline 5.1.1 (Data Collection) — "privacy policy unclear".**
The policy at `https://hakeem-hannoon.github.io/screw-adobe/privacy.html` states no data is collected, explains on-device processing, where files are saved, and how to delete them.

**Guideline 2.3 (Accurate Metadata).**
Screenshots are the actual app; every feature in the description exists in the build.

## Don't

- Don't mention other companies' products (Adobe, Acrobat, etc.) in notes, screenshots or the description.
- Don't say "beta", "test" or "coming soon" anywhere in the listing.
