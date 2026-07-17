#!/usr/bin/env python3
"""
URL Extractor
Extracts all page URLs from a sitemap and saves them to a CSV file.
"""
import argparse
import xml.etree.ElementTree as ET
import csv
import re
import os
import sys

try:
    import cloudscraper
    session = cloudscraper.create_scraper()
except ImportError:
    import requests
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection": "keep-alive",
    })


def extract_urls(sitemap_url):
    response = session.get(sitemap_url, timeout=30)
    content = response.content
    if content.strip().startswith(b"<!DOCTYPE") or content.strip().startswith(b"<html"):
        print(f"[ERROR] {sitemap_url} is returning an HTML page (Cloudflare bot protection). Whitelist your server IP in Cloudflare.")
        sys.exit(1)
    if response.status_code != 200:
        print(f"[ERROR] Failed to fetch sitemap (HTTP {response.status_code}): {sitemap_url}")
        sys.exit(1)

    tree = ET.fromstring(response.content)
    urls = set()
    url_pattern = re.compile(r'https?://[^\s<>"]+')

    for elem in tree.iter():
        if elem.text:
            for match in url_pattern.findall(elem.text):
                urls.add(match.strip())

    return list(urls)


def main():
    parser = argparse.ArgumentParser(description="URL Extractor")
    parser.add_argument("--sitemap_url", required=True, help="Sitemap URL to extract URLs from")
    parser.add_argument("--output_file", default="", help="Path to save the output CSV file")
    args = parser.parse_args()

    print(f"[INFO] Fetching sitemap: {args.sitemap_url}")
    urls = extract_urls(args.sitemap_url)
    print(f"[INFO] Total URLs extracted: {len(urls)}")

    if not urls:
        print("[WARN] No URLs found in the sitemap.")
        return

    output_file = args.output_file if args.output_file else "extracted_urls.csv"
    with open(output_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["URL"])
        for url in sorted(urls):
            writer.writerow([url])

    print(f"[DONE] Saved {len(urls)} URLs to: {os.path.abspath(output_file)}")


if __name__ == "__main__":
    main()
