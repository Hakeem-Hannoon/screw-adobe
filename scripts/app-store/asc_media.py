"""Upload the App Store screenshots and the App Review sample PDF through the
App Store Connect API, for the version that is "Prepare for Submission".

Replaces any screenshots already in the iPhone 6.9" and iPad 13" slots, so it
is safe to run again after regenerating them.

Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8), ASC_APP_ID.
Needs: pip install pyjwt[crypto] requests
"""

import hashlib
import os
import sys
import time
from pathlib import Path

import jwt
import requests

API = "https://api.appstoreconnect.apple.com/v1"
ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "vault" / "Attachments" / "App Store"
SETS = {
    "APP_IPHONE_67": SHOTS / "iPhone 6.9in (1320x2868)",  # the 6.9" slot
    "APP_IPAD_PRO_3GEN_129": SHOTS / "iPad 13in (2064x2752)",  # the 13" slot
}
REVIEW_FILE = SHOTS / "Review sample - Tenancy Confirmation.pdf"


def token() -> str:
    key = Path(os.environ["ASC_KEY_PATH"]).read_text()
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 1000, "aud": "appstoreconnect-v1"},
        key,
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


S = requests.Session()


def call(method: str, path: str, **kw):
    S.headers["Authorization"] = f"Bearer {token()}"
    r = S.request(method, path if path.startswith("http") else API + path, timeout=120, **kw)
    if r.status_code >= 400:
        sys.exit(f"{method} {path} -> {r.status_code}\n{r.text}")
    return r.json() if r.content else {}


def upload_asset(create_path: str, rel_name: str, rel_type: str, rel_id: str, asset_type: str, f: Path) -> str:
    data = f.read_bytes()
    created = call("POST", create_path, json={"data": {
        "type": asset_type,
        "attributes": {"fileName": f.name, "fileSize": len(data)},
        "relationships": {rel_name: {"data": {"type": rel_type, "id": rel_id}}},
    }})["data"]
    for op in created["attributes"]["uploadOperations"]:
        chunk = data[op["offset"]: op["offset"] + op["length"]]
        headers = {h["name"]: h["value"] for h in op.get("requestHeaders", [])}
        r = requests.request(op["method"], op["url"], data=chunk, headers=headers, timeout=300)
        r.raise_for_status()
    call("PATCH", f"{create_path}/{created['id']}", json={"data": {
        "type": asset_type, "id": created["id"],
        "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()},
    }})
    return created["id"]


def main() -> None:
    app = os.environ["ASC_APP_ID"]
    versions = call("GET", f"/apps/{app}/appStoreVersions", params={"filter[platform]": "IOS", "limit": 20})["data"]
    editable = [v for v in versions if v["attributes"].get("appStoreState") in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED")]
    if not editable:
        sys.exit("No editable App Store version found.")
    version = editable[0]
    print("Version", version["attributes"]["versionString"], version["attributes"]["appStoreState"])

    locs = call("GET", f"/appStoreVersions/{version['id']}/appStoreVersionLocalizations")["data"]
    loc = next((l for l in locs if l["attributes"]["locale"] == "en-US"), locs[0])
    existing = {s["attributes"]["screenshotDisplayType"]: s["id"]
                for s in call("GET", f"/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets")["data"]}

    for display, folder in SETS.items():
        files = sorted(folder.glob("*.png"))
        if display in existing:
            set_id = existing[display]
            for shot in call("GET", f"/appScreenshotSets/{set_id}/appScreenshots")["data"]:
                call("DELETE", f"/appScreenshots/{shot['id']}")
        else:
            set_id = call("POST", "/appScreenshotSets", json={"data": {
                "type": "appScreenshotSets",
                "attributes": {"screenshotDisplayType": display},
                "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc["id"]}}},
            }})["data"]["id"]
        for f in files:
            upload_asset("/appScreenshots", "appScreenshotSet", "appScreenshotSets", set_id, "appScreenshots", f)
            print("  uploaded", display, f.name)

    # The App Review attachment (sample PDF for the reviewer).
    detail = call("GET", f"/appStoreVersions/{version['id']}/appStoreReviewDetail").get("data")
    if detail and REVIEW_FILE.exists():
        old = call("GET", f"/appStoreReviewDetails/{detail['id']}/appStoreReviewAttachments")["data"]
        if not any(a["attributes"]["fileName"] == REVIEW_FILE.name for a in old):
            upload_asset("/appStoreReviewAttachments", "appStoreReviewDetail", "appStoreReviewDetails",
                         detail["id"], "appStoreReviewAttachments", REVIEW_FILE)
            print("  uploaded review attachment", REVIEW_FILE.name)

    # Wait for Apple to process the screenshots, and report any that failed.
    time.sleep(20)
    bad = 0
    for display in SETS:
        sets = call("GET", f"/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets")["data"]
        set_id = next(s["id"] for s in sets if s["attributes"]["screenshotDisplayType"] == display)
        for shot in call("GET", f"/appScreenshotSets/{set_id}/appScreenshots")["data"]:
            state = (shot["attributes"].get("assetDeliveryState") or {}).get("state")
            print(f"  {display} {shot['attributes']['fileName']}: {state}")
            if state == "FAILED":
                bad += 1
    if bad:
        sys.exit(f"{bad} screenshots failed processing")


if __name__ == "__main__":
    main()
