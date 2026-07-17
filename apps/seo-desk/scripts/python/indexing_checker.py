#!/usr/bin/env python3
"""
Indexing Checker
Checks Google Search Console URL Inspection API for each URL.
Saves a full CSV report to index_status_report.csv.
"""
import argparse
import time
import os
import sys
from googleapiclient.discovery import build
from google.oauth2 import service_account
import pandas as pd


def main():
    parser = argparse.ArgumentParser(description="Indexing Checker")
    parser.add_argument("--service_account_file", required=True)
    parser.add_argument("--gsc_property", required=True, help="Exact GSC property URL")
    parser.add_argument("--urls", default="", help="Newline-separated URLs to check")
    parser.add_argument("--csv_file", default="", help="CSV file with a 'url' column")
    args = parser.parse_args()

    # Load URLs
    if args.csv_file:
        df = pd.read_csv(args.csv_file)
        df.columns = df.columns.str.strip().str.lower()
        urls = df["url"].dropna().tolist()
        print(f"[INFO] Loaded {len(urls)} URLs from CSV")
    elif args.urls:
        urls = [u.strip() for u in args.urls.splitlines() if u.strip()]
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
        scopes=["https://www.googleapis.com/auth/webmasters"]
    )
    service = build("searchconsole", "v1", credentials=credentials)

    total = len(urls)
    print(f"[INFO] GSC Property: {args.gsc_property}")
    print(f"[INFO] Checking {total} URL(s)...\n")

    results = []
    start_time = time.time()

    for i, url in enumerate(urls, start=1):
        try:
            response = service.urlInspection().index().inspect(body={
                "inspectionUrl": url,
                "siteUrl": args.gsc_property
            }).execute()

            index_result = response["inspectionResult"]["indexStatusResult"]
            verdict = index_result.get("verdict", "UNKNOWN")

            results.append({
                "URL": url,
                "Coverage State": index_result.get("coverageState"),
                "Indexing State": index_result.get("indexingState"),
                "Last Crawl Time": index_result.get("lastCrawlTime"),
                "Verdict": verdict,
            })

            elapsed = int(time.time() - start_time)
            print(f"[INFO] [{i}/{total}] {verdict} | {url} | {elapsed}s elapsed")

        except Exception as e:
            results.append({
                "URL": url,
                "Coverage State": "ERROR",
                "Indexing State": "ERROR",
                "Last Crawl Time": "",
                "Verdict": str(e)[:100],
            })
            print(f"[ERROR] [{i}/{total}] {url} — {str(e)[:80]}")

        time.sleep(1)

    output_file = "index_status_report.csv"
    pd.DataFrame(results).to_csv(output_file, index=False)

    print(f"\n[DONE] Report saved to: {os.path.abspath(output_file)}")


if __name__ == "__main__":
    main()
