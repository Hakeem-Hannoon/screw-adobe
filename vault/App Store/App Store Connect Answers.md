---
tags: [app-store, metadata]
---

# App Store Connect Answers

[[Home]] · [[App Store/Release Checklist|Release Checklist]] · [[App Store/Listing Copy|Listing Copy]]

Every field App Store Connect asks for, in the order you meet it, with the answer to give. Checked against Apple's requirements as of November 2026.

## App Information (sidebar › General › App Information)

| Field | Answer |
| --- | --- |
| Name | `HackerPDF` |
| Subtitle | `Redact, sign & merge PDFs` |
| Bundle ID | `com.hakeemhannoon.hackerpdf` |
| SKU | `hackerpdf-ios` |
| Primary language | English (Canada) or English (U.S.) |
| Primary category | **Productivity** |
| Secondary category | **Utilities** |
| Content Rights | **No**, the app does not contain, show or access third-party content. (The bundled fonts are open-source software under the SIL Open Font License, not content.) |
| Age Rating | Answer as in [[App Store/Age Rating]] → **4+** |
| License Agreement | Apple's standard EULA (leave as is) |

## App Privacy (sidebar › App Privacy)

| Field | Answer |
| --- | --- |
| Privacy Policy URL | `https://hakeem-hannoon.github.io/screw-adobe/privacy.html` |
| User Privacy Choices URL | Leave empty (there's nothing to choose) |
| Data collection | **No, we do not collect data from this app** |
| Resulting label | **Data Not Collected** |

The reasoning for every data type is in [[App Store/Privacy and Data Security]].

## Pricing and Availability

| Field | Answer |
| --- | --- |
| Price | **Free** (USD 0.00) |
| In-app purchases / subscriptions | None. Don't create any. |
| Availability | All countries or regions **except China mainland**. Apps in China mainland need an ICP filing number entered in App Store Connect; leave it unticked unless you get one. |
| Pre-order | No |
| Distribution | Public on the App Store |
| iPhone and iPad apps on Apple silicon Mac | **Off** for 1.0 (untested on Mac; can be turned on later) |
| Apple Vision Pro | **Off** for 1.0 (untested) |
| Tax category | Leave the default (free app) |

## EU Digital Services Act (trader status)

Apple requires every developer to declare whether they're a **trader** before the app can appear in the EU.

- **Not a trader**: you're an individual publishing a free app with no ads, purchases or other income, not as part of a business. The app is still available in all EU countries; no contact details are published.
- **Trader**: if you run this as a business. Apple then verifies and shows your address, phone and email on the EU App Store page.

For a free personal project, "not a trader" is the usual answer, but it's a legal self-declaration, so decide based on your situation (I'm not a lawyer).

## Version 1.0 › iPhone and iPad

| Field | Answer |
| --- | --- |
| iPhone 6.9" screenshots | The 8 files in `Attachments/App Store/iPhone 6.9in (1320x2868)/`, in order |
| iPad 13" screenshots | The 8 files in `Attachments/App Store/iPad 13in (2064x2752)/`, in order |
| App Preview video | None (optional) |
| Promotional Text | See [[App Store/Listing Copy#Promotional text (170 max)]] |
| Description | See [[App Store/Listing Copy#Description (4000 max)]] |
| Keywords | See [[App Store/Listing Copy#Keywords (100 max)]] |
| Support URL | `https://hakeem-hannoon.github.io/screw-adobe/support.html` |
| Marketing URL | `https://hakeem-hannoon.github.io/screw-adobe/` |
| Version | `1.0` |
| Copyright | `2026 Hakeem Hannoon` |
| Routing App Coverage File | None (not a navigation app) |
| Game Center | Off |
| Build | The build you uploaded from Xcode |

## App Review Information

| Field | Answer |
| --- | --- |
| Sign-in required | **No** (there are no accounts) |
| Contact first / last name | Hakeem Hannoon |
| Phone | Your phone number (only Apple sees it) |
| Email | `hakeemhannoon@gmail.com` |
| Notes | Paste from [[App Store/App Review Notes]] |
| Attachment | `Attachments/App Store/Review sample - Tenancy Confirmation.pdf` |

## Export compliance (encryption)

You won't be asked, because the build's Info.plist sets `ITSAppUsesNonExemptEncryption = NO`. If App Store Connect ever asks anyway, answer:

1. *Does your app use encryption?* → **Yes** (pdf.js can decrypt password-protected PDFs).
2. *Does your app qualify for any of the exemptions provided in Category 5, Part 2 of the U.S. Export Administration Regulations?* → **Yes**: it's limited to *the decryption of data or files*. The app never encrypts anything and makes no network connections.

Details: [[App Store/Privacy and Data Security#Export compliance (encryption)]].

## Advertising identifier (IDFA)

Not used. There's no question to answer unless you add an ads or analytics SDK, which this app has none of.

## Made for Kids

**Not Applicable.** Don't pick the Kids category: it brings extra rules and can't be undone after approval.

## Accessibility (Accessibility Nutrition Labels)

Optional, and voluntary. Leave undeclared for 1.0. Declare features (VoiceOver, Larger Text, Dark Interface, etc.) only after you've tested each one end to end on a device, since Apple may check them.

## Version Release

**Manually release this version** for 1.0.
