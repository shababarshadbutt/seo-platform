#!/usr/bin/env python3
"""
Bing IndexNow Submitter
Submits a list of URLs to Bing via the IndexNow protocol for instant indexing.
URLs are sent in batches of 200 to avoid timeouts on large submissions.
"""
import argparse
import csv
import json
import os
import sys
import time
import traceback
from urllib.parse import urlparse

import requests

DEFAULT_INDEXNOW_KEY = "be54d4b639b44b8ca5b9cd5d5493a8e6"
BATCH_SIZE = 200


def _write_csv(output_file, results):
    if not output_file:
        return
    with open(output_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["URL", "Status", "Batch", "HTTP Code"])
        writer.writerows(results)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--urls", required=True, help="Newline-separated URLs to submit")
    parser.add_argument("--output_file", required=False, help="Path to write submission log CSV")
    parser.add_argument("--api_key", required=False, default="", help="IndexNow API key (overrides default)")
    args = parser.parse_args()

    INDEXNOW_KEY = args.api_key.strip() if args.api_key and args.api_key.strip() else DEFAULT_INDEXNOW_KEY

    # When the URL list is large, the route writes it to a temp .txt file
    # and passes the file path instead of the raw string.
    if os.path.isfile(args.urls):
        with open(args.urls, "r", encoding="utf-8") as f:
            url_list = [u.strip() for u in f if u.strip()]
    else:
        url_list = [u.strip() for u in args.urls.splitlines() if u.strip()]

    print("[INFO] Bing URL Indexer started.", flush=True)

    if not url_list:
        print("[ERROR] No URLs provided.", flush=True)
        sys.exit(1)

    # Auto-extract host from the first URL
    parsed = urlparse(url_list[0])
    host = f"{parsed.scheme}://{parsed.netloc}"
    key_location = f"{host}/{INDEXNOW_KEY}.txt"

    total = len(url_list)
    batches = [url_list[i:i + BATCH_SIZE] for i in range(0, total, BATCH_SIZE)]

    print(f"[INFO] Total URLs  : {total}", flush=True)
    print(f"[INFO] Total batches: {len(batches)} (up to {BATCH_SIZE} URLs each)", flush=True)
    print(f"[INFO] Host        : {host}", flush=True)
    print(f"[INFO] Key Location: {key_location}", flush=True)

    submitted = 0
    results = []  # (url, status, batch_num, http_code)

    for i, batch in enumerate(batches):
        print(f"\n[INFO] Submitting batch {i + 1}/{len(batches)} ({len(batch)} URLs)...", flush=True)

        payload = {
            "host": host,
            "key": INDEXNOW_KEY,
            "keyLocation": key_location,
            "urlList": batch,
        }

        try:
            response = requests.post(
                "https://www.bing.com/indexnow",
                headers={"Content-Type": "application/json; charset=utf-8"},
                data=json.dumps(payload),
                timeout=30,
            )

            resp_text = response.content.decode("utf-8", errors="replace").strip()
            print(f"[INFO] Status Code: {response.status_code}", flush=True)
            if resp_text:
                print(f"[INFO] Response: {resp_text}", flush=True)

            if response.status_code in (200, 202):
                submitted += len(batch)
                for url in batch:
                    results.append((url, "Submitted", i + 1, response.status_code))
                print(f"[INFO] Batch {i + 1} accepted. ({submitted}/{total} submitted so far)", flush=True)
            else:
                for url in batch:
                    results.append((url, "Failed", i + 1, response.status_code))
                print(f"[ERROR] Batch {i + 1} failed with status {response.status_code}", flush=True)
                _write_csv(args.output_file, results)
                sys.exit(1)

        except requests.exceptions.Timeout:
            for url in batch:
                results.append((url, "Timeout", i + 1, ""))
            print(f"[ERROR] Batch {i + 1} timed out after 30 seconds.", flush=True)
            _write_csv(args.output_file, results)
            sys.exit(1)
        except requests.exceptions.RequestException as e:
            for url in batch:
                results.append((url, "Error", i + 1, ""))
            print(f"[ERROR] Batch {i + 1} request failed: {e}", flush=True)
            _write_csv(args.output_file, results)
            sys.exit(1)

        # Small delay between batches to avoid rate limiting
        if i < len(batches) - 1:
            time.sleep(1)

    _write_csv(args.output_file, results)
    print(f"\n[DONE] SUCCESS - {submitted} URL(s) submitted to Bing IndexNow!", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[ERROR] Unexpected crash: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        sys.exit(1)
