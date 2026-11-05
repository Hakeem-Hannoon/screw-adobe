---
tags: [app-store, release]
---

# Release Checklist

[[Home]] · [[App Store/App Store Connect Answers|Answers]] · [[iOS App]]

Everything in the repository is ready. These are the steps only you can do, because they need your Apple account, a Mac and your signature on Apple's agreements. Tick them off in order.

## 1. Accounts (one time)

- [ ] Join the **Apple Developer Program** at [developer.apple.com/programs](https://developer.apple.com/programs/) as an **individual** (99 USD a year, also required for free apps). Your legal name becomes the seller name shown on the App Store.
- [ ] In [App Store Connect](https://appstoreconnect.apple.com) › **Business**, accept the latest **Apple Developer Program License Agreement**. A free app does **not** need the Paid Apps agreement, tax or banking forms.
- [ ] Still in **Business** (or when App Store Connect prompts you), set your **EU Digital Services Act trader status**. See [[App Store/App Store Connect Answers#EU Digital Services Act (trader status)]].

## 2. Register the bundle ID

- [ ] [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) › **+** › App IDs › App.
  - Description: `HackerPDF`
  - Bundle ID (Explicit): `com.hakeemhannoon.hackerpdf`
  - Capabilities: leave everything off.

(Xcode can also do this automatically in step 4.)

## 3. Create the app record

- [ ] App Store Connect › **Apps** › **+** › **New App**:
  - Platforms: **iOS** (this covers iPhone and iPad)
  - Name: `HackerPDF` (if it's taken, use `HackerPDF – Redact & Sign`)
  - Primary language: **English (Canada)** or **English (U.S.)**
  - Bundle ID: `com.hakeemhannoon.hackerpdf`
  - SKU: `hackerpdf-ios`
  - User access: Full access

## 4a. Build and upload without a Mac (GitHub Actions)

The **iOS release** workflow (`.github/workflows/ios-release.yml`) archives, signs and uploads the app on a macOS runner, and uploads the screenshots and the review sample PDF through the App Store Connect API.

- One-time: an App Store Connect **Team API key** with **Admin** access ("GitHub Actions HackerPDF"), with its `.p8` contents saved as the repository secret `APPSTORE_API_PRIVATE_KEY`. The key ID and issuer ID are in the workflow file (they're identifiers, not secrets).
- Run it: GitHub › Actions › **iOS release** › *Run workflow*. Leave the build number empty to use the run number; it must go up with every upload.
- Signing is "cloud signing": Xcode uses the key to fetch or create the distribution certificate and profile, so no certificate is stored anywhere in the repo.

## 4b. Or build and upload from a Mac (Xcode 26 or later)

```bash
git pull
npm install
npm run ios          # builds the web app, copies it in, opens Xcode
```

- [ ] In Xcode, select the **App** project › **App** target › **Signing & Capabilities**: tick *Automatically manage signing* and pick your **Team**.
- [ ] Choose **Any iOS Device (arm64)** as the destination.
- [ ] Quick check on your own iPhone and an iPad (or simulator): open a PDF, redact, save, and confirm it appears in Files › On My iPhone › HackerPDF.
- [ ] **Product › Archive** → in the Organizer, **Distribute App** › **App Store Connect** › **Upload**.
- [ ] Wait for the processing email (about 5–30 minutes). Because `ITSAppUsesNonExemptEncryption` is `NO`, there is no export-compliance question for this build.

## 5. TestFlight (recommended)

- [ ] App Store Connect › **TestFlight** › add yourself as an internal tester and install the build on a real iPhone **and** iPad. Try every tool once, including OCR and Word to PDF.

## 6. Fill in the App Store page

Copy the answers from these notes:

- [ ] **App Information** — category, content rights, age rating → [[App Store/App Store Connect Answers]] and [[App Store/Age Rating]]
- [ ] **App Privacy** — privacy policy URL and "Data Not Collected" → [[App Store/Privacy and Data Security]]
- [ ] **Pricing and Availability** — Free, countries → [[App Store/App Store Connect Answers#Pricing and Availability]]
- [ ] **Version 1.0** — screenshots, promotional text, description, keywords, support URL, copyright → [[App Store/Listing Copy]] and [[App Store/Screenshots]]
- [ ] **Build** — pick the uploaded build
- [ ] **App Review Information** — notes and the sample PDF → [[App Store/App Review Notes]]
- [ ] **Version Release** — "Manually release this version" for your first launch, so you choose the moment.

## 7. Submit

- [ ] **Add for Review** › **Submit**. First reviews usually take 1–2 days. If Apple asks a question, it appears in App Store Connect › **App Review**; answer there.
- [ ] Once approved, press **Release This Version**.

## Before you submit, make sure

- [ ] The website is deployed with `privacy.html` and `support.html` live (they are part of this branch; GitHub Pages publishes them on merge to `main`).
- [ ] You're happy with the support email shown on those pages (`hakeemhannoon@gmail.com`). Reviewers and users will see it.
- [ ] The screenshots match the build you upload. If the UI changes, regenerate them (see [[App Store/Screenshots#Regenerating]]).

## Later updates

1. Make changes, then bump the version in Xcode (*General › Identity*): `MARKETING_VERSION` for users (1.0.1, 1.1) and `CURRENT_PROJECT_VERSION` (build) for every upload.
2. `npm run ios`, archive, upload, add "What's New" text, submit.
