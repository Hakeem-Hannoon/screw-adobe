---
tags: [app-store, privacy, security]
---

# Privacy and Data Security

[[Home]] · [[App Store/App Store Connect Answers|Answers]] · [[iOS App]]

## The short version

HackerPDF collects nothing, tracks nothing and sends nothing. Files are processed in memory on the device and saved back to the device. There are no accounts, analytics, ads, crash reporters or third-party SDKs that collect data, and the app makes no network requests.

Public policy: [privacy.html](https://hakeem-hannoon.github.io/screw-adobe/privacy.html) (source: `public/privacy.html`).

## App Privacy questionnaire

App Store Connect › App Privacy › **Get Started**:

> *Do you or your third-party partners collect data from this app?* → **No, we do not collect data from this app.**

Apple defines "collect" as transmitting data off the device in a way that lets you or a partner access it for longer than needed to service the request in real time. Nothing leaves the device, so every category below is "not collected":

| Apple data category | Collected? | Why |
| --- | --- | --- |
| Contact Info (name, email, phone, address) | No | No accounts or forms. A name typed for a signature is drawn into the PDF on the device and never sent. |
| Health & Fitness | No | — |
| Financial Info | No | No purchases. Numbers inside documents stay on the device. |
| Location | No | No location access. Images to PDF actively **removes** GPS data from photos. |
| Sensitive Info | No | — |
| Contacts | No | No contacts access. |
| User Content (photos, documents, other) | No | Files are opened and saved on the device only; never uploaded. |
| Browsing History / Search History | No | Find-in-document runs locally and isn't stored. |
| Identifiers (user ID, device ID / IDFA) | No | None used; no App Tracking Transparency prompt. |
| Purchases | No | Free, no in-app purchases. |
| Usage Data (product interaction, advertising data) | No | No analytics. |
| Diagnostics (crash data, performance) | No | No crash reporting SDK. (Apple's own opt-in crash reports are Apple's, not the app's.) |
| Surroundings / Body | No | — |
| Other Data | No | — |

**Tracking:** No. **Label shown on the App Store:** *Data Not Collected*.

## Privacy manifest (`PrivacyInfo.xcprivacy`)

Required by Apple since May 2024 for every app. Ours declares:

- `NSPrivacyTracking` = **false**, no tracking domains
- `NSPrivacyCollectedDataTypes` = **empty**
- `NSPrivacyAccessedAPITypes`: **File timestamp** (`NSPrivacyAccessedAPICategoryFileTimestamp`) with reason **C617.1**, "access the timestamps … of files inside the app container". The Filesystem plugin reads file info when checking whether a save name is already taken.

Capacitor's own frameworks ship their own manifests (also no tracking, no data). Xcode merges them into the app's privacy report: *Product › Archive › Organizer › right-click the archive › Generate Privacy Report*.

## Permissions the app asks for

None. No camera, microphone, photo library, location, contacts, tracking, notifications or local-network prompts. Files and photos come in through the system pickers, which give the app only what the user selects, and need no permission string.

## Export compliance (encryption)

`ITSAppUsesNonExemptEncryption = NO` in `Info.plist`.

- The app has no networking, so no HTTPS/TLS.
- The only cryptography is pdf.js **decrypting** a password-protected PDF the user opens with its password, so it can be displayed and edited. Output files are never encrypted.
- Apple's exemptions under Category 5, Part 2 include encryption *limited to authentication, digital signature, or the decryption of data or files*. That's exactly this case, so no export documentation, ERN or annual self-classification report is needed.

If the app ever adds password-*protecting* output files, or networking with custom crypto, revisit this answer.

## Data security, in detail (for reviewers and curious users)

| Question | Answer |
| --- | --- |
| Where are files processed? | In the app's WebView memory on the device. |
| Is anything sent to a server? | No. The app has no server and makes no requests. A Content-Security-Policy (`connect-src 'self'`) blocks the page from contacting any other host even if code tried. |
| Is the app usable offline? | Yes, completely. |
| Where are saved files stored? | The app's Documents folder, visible in Files › On My iPhone/iPad › HackerPDF. Protected by iOS data protection like any app's files. |
| Are files encrypted at rest? | By iOS, using the device passcode (standard Data Protection). The app adds nothing on top. |
| Is redaction permanent? | Yes. Edited pages are rendered to images with the boxes burned in; the original text, fonts, links and hidden layers on those pages are not in the output. Untouched pages are copied with anything pointing back to edited pages removed. The output is a new PDF without the original's metadata, bookmarks, attachments or scripts. |
| What about metadata? | Output PDFs and Word files carry no author or app metadata. Images to PDF strips EXIF (GPS, time, device serial). |
| Passwords | A PDF password is used once in memory to open the file and is never stored or sent. Saved copies have no password. |
| Is there any third-party code? | Open-source libraries bundled in the app: pdf.js, pdf-lib, Tesseract.js (OCR model bundled, English), docx-preview, JSZip, marked, and open-source fonts. None contacts a server. |
| Can the developer see user files? | No. There is no channel through which they could reach the developer. |
| Data deletion request? | Nothing to delete: no data is held. Users delete their own saved files in Files, or delete the app. |
| Children's data | None collected from anyone. |
| GDPR / PIPEDA / CCPA | No personal data is processed by the developer, so there's nothing to access, correct, export or delete on request. |
