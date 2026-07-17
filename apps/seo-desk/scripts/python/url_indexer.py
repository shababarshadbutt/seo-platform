#!/usr/bin/env python3
"""
URL Indexer
Submits URLs to Google's Indexing API. Skips URLs that don't return HTTP 200.
Logs all results to indexing_log.csv.
"""
import argparse
import requests
import csv
import time
import os
import sys
from google.oauth2 import service_account
from googleapiclient.discovery import build


def check_url_status(url):
    try:
        response = requests.head(url, timeout=10)
        if response.status_code == 405:
            response = requests.get(url, timeout=10)
        return response.status_code
    except requests.RequestException:
        return None


def main():
    parser = argparse.ArgumentParser(description="URL Indexer")
    parser.add_argument("--service_account_file", required=True)
    parser.add_argument("--urls", default="", help="Newline-separated URLs to index")
    parser.add_argument("--csv_file", default="", help="CSV file with a 'url' column")
    parser.add_argument("--output_file", default="indexing_log.csv", help="Path for the CSV output log")
    args = parser.parse_args()

    # Load URLs
    if args.csv_file:
        import pandas as pd
        df = pd.read_csv(args.csv_file)
        df.columns = df.columns.str.strip().str.lower()
        urls = df["url"].dropna().tolist()
        print(f"[INFO] Loaded {len(urls)} URLs from CSV")
    elif args.urls:
        # Skip comment lines (# Website Name headers added by multi-site UI)
        urls = [u.strip() for u in args.urls.splitlines()
                if u.strip() and not u.strip().startswith("#")]
        print(f"[INFO] Loaded {len(urls)} URLs")
    else:
        print("[ERROR] Provide either --urls or --csv_file", file=sys.stderr)
        sys.exit(1)

    if not urls:
        print("[ERROR] No URLs found.")
        sys.exit(1)

    # Auth
    credentials = service_account.Credentials.from_service_account_file(
        args.service_account_file,
        scopes=["https://www.googleapis.com/auth/indexing"]
    )
    service = build("indexing", "v3", credentials=credentials)

    # CSV log setup
    output_file = args.output_file
    with open(output_file, "w", newline="", encoding="utf-8") as csvfile:
        csv.writer(csvfile).writerow(["URL", "HTTP_Status", "Result"])

    print(f"[INFO] Starting indexing for {len(urls)} URL(s)...\n")

    for i, url in enumerate(urls, start=1):
        status = check_url_status(url)
        result = ""

        if status != 200:
            result = f"Skipped (HTTP {status})"
            print(f"[WARN] [{i}/{len(urls)}] Skipped: {url} [HTTP {status}]")
        else:
            try:
                service.urlNotifications().publish(
                    body={"url": url, "type": "URL_UPDATED"}
                ).execute()
                result = "Indexed Successfully"
                print(f"[INFO] [{i}/{len(urls)}] Submitted: {url}")
                time.sleep(2)
            except Exception as e:
                result = f"Error: {str(e)[:150]}"
                print(f"[ERROR] [{i}/{len(urls)}] {url} — {str(e)[:100]}")

        with open(output_file, "a", newline="", encoding="utf-8") as csvfile:
            csv.writer(csvfile).writerow([url, status, result])

    print(f"\n[DONE] Log saved to: {os.path.abspath(output_file)}")


if __name__ == "__main__":
    main()
