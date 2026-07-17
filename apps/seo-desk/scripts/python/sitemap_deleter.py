#!/usr/bin/env python3
"""
Sitemap Deleter
Removes specific sitemaps from a Google Search Console property.
"""
import argparse
import os
from googleapiclient.discovery import build
from google.oauth2 import service_account


def main():
    parser = argparse.ArgumentParser(description="Sitemap Deleter")
    parser.add_argument("--service_account_file", required=True)
    parser.add_argument("--gsc_property", required=True, help="Exact GSC property URL")
    parser.add_argument("--sitemap_urls", required=True,
                        help="Newline-separated sitemap URLs to delete, or path to a text file")
    args = parser.parse_args()

    if os.path.isfile(args.sitemap_urls):
        with open(args.sitemap_urls, "r", encoding="utf-8") as f:
            sitemaps = [u.strip() for u in f if u.strip()]
    else:
        sitemaps = [u.strip() for u in args.sitemap_urls.splitlines() if u.strip()]
    if not sitemaps:
        print("[ERROR] No sitemap URLs provided.")
        return

    print("[INFO] Authenticating...")
    creds = service_account.Credentials.from_service_account_file(
        args.service_account_file,
        scopes=["https://www.googleapis.com/auth/webmasters"]
    )
    service = build("webmasters", "v3", credentials=creds)

    print(f"[INFO] Property: {args.gsc_property}")
    print(f"[INFO] Deleting {len(sitemaps)} sitemap(s)...\n")

    for sitemap in sitemaps:
        try:
            service.sitemaps().delete(
                siteUrl=args.gsc_property,
                feedpath=sitemap
            ).execute()
            print(f"[INFO] Deleted: {sitemap}")
        except Exception as e:
            print(f"[ERROR] Failed to delete {sitemap} — {e}")

    print(f"\n[DONE] Completed!")


if __name__ == "__main__":
    main()
