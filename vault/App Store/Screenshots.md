---
tags: [app-store, screenshots]
---

# Screenshots

[[Home]] · [[App Store/App Store Connect Answers|Answers]]

## What Apple requires

| Slot in App Store Connect | Required? | Accepted portrait sizes | Ours |
| --- | --- | --- | --- |
| **iPhone 6.9" Display** | Yes (the app runs on iPhone) | 1320 × 2868, 1290 × 2796, 1260 × 2736 | **1320 × 2868** |
| **iPad 13" Display** | Yes (the app runs on iPad) | 2064 × 2752, 2048 × 2732 | **2064 × 2752** |
| Smaller iPhones and iPads | No | — | Apple scales the two sets above down automatically |

1 to 10 screenshots per slot, PNG or JPEG, RGB, no transparency. App Store Connect rejects a file that's even one pixel off, so these were rendered at the exact size and checked by script: all 16 captioned and all 16 plain files are the sizes above, 8-bit sRGB, no alpha channel.

## How to upload

1. App Store Connect › your app › **1.0 Prepare for Submission** › *Previews and Screenshots*.
2. **iPhone** tab › *6.9" Display* → drag in the 8 files from `Attachments/App Store/iPhone 6.9in (1320x2868)/` (they're numbered in display order).
3. **iPad** tab › *13" Display* → drag in the 8 files from `Attachments/App Store/iPad 13in (2064x2752)/`.
4. Leave the smaller sizes empty.

The first three screenshots show up in search results, so the order leads with what makes HackerPDF different: free and private, real redaction, cover-every-match.

## The iPhone set (6.9")

| # | Screen | Headline | Line under it |
| --- | --- | --- | --- |
| 01 | Home | Every PDF tool. **Free.** | No ads. No account. Nothing uploaded. |
| 02 | Redact | Black out **anything** | The text underneath is really gone. |
| 03 | Find and cover | Cover every **match** at once | Emails, phone and account numbers in one tap. |
| 04 | Sign: pick a style | Sign in your **own hand** | 20 handwriting styles, or draw your own. |
| 05 | Sign: placed | Tap. Place. **Signed.** | Drag to move, pull the corner to resize. |
| 06 | Merge | Merge PDFs in **seconds** | Drag to reorder. Split them just as fast. |
| 07 | Organize | Every page at a **glance** | Reorder, delete or extract pages. |
| 08 | Convert | PDF to Word, and **back** | Images and text too. Works offline. |

![[Attachments/App Store/iPhone 6.9in (1320x2868)/01-home.png|180]] ![[Attachments/App Store/iPhone 6.9in (1320x2868)/02-redact.png|180]] ![[Attachments/App Store/iPhone 6.9in (1320x2868)/03-find.png|180]] ![[Attachments/App Store/iPhone 6.9in (1320x2868)/04-sign.png|180]]
![[Attachments/App Store/iPhone 6.9in (1320x2868)/05-signed.png|180]] ![[Attachments/App Store/iPhone 6.9in (1320x2868)/06-merge.png|180]] ![[Attachments/App Store/iPhone 6.9in (1320x2868)/07-organize.png|180]] ![[Attachments/App Store/iPhone 6.9in (1320x2868)/08-convert.png|180]]

## The iPad set (13")

Same eight screens and captions, laid out at iPad Pro 13" size.

![[Attachments/App Store/iPad 13in (2064x2752)/01-home.png|240]] ![[Attachments/App Store/iPad 13in (2064x2752)/02-redact.png|240]] ![[Attachments/App Store/iPad 13in (2064x2752)/04-sign.png|240]] ![[Attachments/App Store/iPad 13in (2064x2752)/06-merge.png|240]]

## Plain versions

`Attachments/App Store/Plain screenshots/` has the same 16 screens without headlines or frames, at the same exact sizes. Use them if you prefer raw screens, or for TestFlight and press.

## About the content

- Every screen is the real app (this build), with the iPhone 16/17 Pro Max and iPad Pro 13" screen sizes and safe areas, and a 9:41 status bar.
- The documents are invented samples ("Maple Row Property Management", "Jordan A. Whitfield"); no real person's data appears. The SIN shown is a widely published sample number, not a real one.
- Nothing in the captions promises something the app doesn't do (guideline 2.3.7).

## Regenerating

If the interface changes, regenerate so the screenshots stay accurate. The scripts are in `scripts/app-store/` (see the README there): they build sample PDFs, drive the real app in Chrome at the exact device sizes, and add the captions.
