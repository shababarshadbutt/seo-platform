#!/usr/bin/env python3
"""
GSC Sitemap Submitter
Bulk-submits sitemaps to a Google Search Console property.
"""
import argparse
from google.oauth2 import service_account
from googleapiclient.discovery import build


def main():
    parser = argparse.ArgumentParser(description="GSC Sitemap Submitter")
    parser.add_argument("--service_account_file", required=True)
    parser.add_argument("--gsc_property", required=True, help="Exact GSC property URL")
    parser.add_argument("--sitemap_urls", required=True, help="Newline-separated sitemap URLs")
    args = parser.parse_args()

    sitemaps = [u.strip() for u in args.sitemap_urls.splitlines() if u.strip()]
    if not sitemaps:
        print("[ERROR] No sitemap URLs provided.")
        return

    print("[INFO] Authenticating with Google Search Console...")
    credentials = service_account.Credentials.from_service_account_file(
        args.service_account_file,
        scopes=["https://www.googleapis.com/auth/webmasters"]
    )
    service = build("searchconsole", "v1", credentials=credentials)

    print(f"[INFO] Property: {args.gsc_property}")
    print(f"[INFO] Submitting {len(sitemaps)} sitemap(s)...\n")

    for sitemap in sitemaps:
        try:
            service.sitemaps().submit(
                siteUrl=args.gsc_property,
                feedpath=sitemap
            ).execute()
            print(f"[INFO] Submitted: {sitemap}")
        except Exception as e:
            print(f"[ERROR] Failed: {sitemap} — {e}")

    print(f"\n[DONE] Completed!")


if __name__ == "__main__":
    main()
