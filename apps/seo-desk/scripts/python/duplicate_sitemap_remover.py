#!/usr/bin/env python3
"""
Duplicate Sitemap Remover
Receives a JSON file (pre-parsed client-side) with structure:
  [{"name": "sitemap.xml", "urls": ["url1", "url2", ...]}, ...]
Deduplicates URLs across all sitemaps and outputs a ZIP containing
clean sitemaps + a duplicates report CSV.
"""
import argparse
import csv
import io
import json
import os
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sitemap_files", required=True, help="Path to pre-parsed JSON file")
    parser.add_argument("--output_file", required=True, help="Path for output ZIP")
    args = parser.parse_args()

    if not os.path.isfile(args.sitemap_files):
        print(f"[ERROR] File not found: {args.sitemap_files}", flush=True)
        sys.exit(1)

    # ── Load pre-parsed sitemap data ────────────────────────────────────────────
    with open(args.sitemap_files, "r", encoding="utf-8") as f:
        sitemap_list = json.load(f)

    if not sitemap_list:
        print("[ERROR] No sitemap data found in the uploaded file.", flush=True)
        sys.exit(1)

    print(f"[INFO] Loaded {len(sitemap_list)} sitemap(s)", flush=True)

    all_data = {}
    total_input_urls = 0
    for item in sitemap_list:
        name = item.get("name", "unknown.xml")
        urls = item.get("urls", [])
        all_data[name] = urls
        total_input_urls += len(urls)
        print(f"[INFO] {name} -> {len(urls)} URLs", flush=True)

    print(f"[INFO] Total URLs across all sitemaps: {total_input_urls}", flush=True)

    # ── Build duplicate map ─────────────────────────────────────────────────────
    print("[INFO] Finding duplicates...", flush=True)
    url_map = defaultdict(set)
    for name, urls in all_data.items():
        for url in urls:
            url_map[url].add(name)

    duplicates = {u: s for u, s in url_map.items() if len(s) > 1}
    print(f"[INFO] Found {len(duplicates)} duplicate URL(s) across sitemaps", flush=True)

    # ── Write output ZIP ────────────────────────────────────────────────────────
    print("[INFO] Cleaning sitemaps...", flush=True)
    seen = set()
    total_kept = total_removed = 0

    with zipfile.ZipFile(args.output_file, "w", zipfile.ZIP_DEFLATED) as zout:

        # Clean sitemaps
        for name, urls in all_data.items():
            root = ET.Element("urlset")
            root.set("xmlns", "http://www.sitemaps.org/schemas/sitemap/0.9")
            kept = removed = 0

            for url in urls:
                if url in seen:
                    removed += 1
                    continue
                seen.add(url)
                u = ET.SubElement(root, "url")
                ET.SubElement(u, "loc").text = url
                kept += 1

            xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            zout.writestr(f"clean_sitemaps/{name}", xml_bytes)
            total_kept += kept
            total_removed += removed
            print(f"[INFO] {name} -> kept: {kept}, removed: {removed}", flush=True)

        # Duplicates CSV (batched at 50,000 rows per file)
        if duplicates:
            batch_size = 50000
            items = list(duplicates.items())
            for batch_idx in range(0, len(items), batch_size):
                chunk = items[batch_idx:batch_idx + batch_size]
                file_num = (batch_idx // batch_size) + 1
                buf = io.StringIO()
                writer = csv.writer(buf)
                writer.writerow(["URL", "Duplicate Count", "Sitemaps"])
                for url, sitemaps in chunk:
                    writer.writerow([url, len(sitemaps), ", ".join(sorted(sitemaps))])
                zout.writestr(
                    f"duplicates/duplicates_{file_num}.csv",
                    buf.getvalue().encode("utf-8")
                )
                print(f"[INFO] Duplicates batch {file_num} written ({len(chunk)} rows)", flush=True)
        else:
            print("[INFO] No duplicates found - skipping duplicates CSV", flush=True)

    print(f"\n[INFO] Total URLs kept  : {total_kept}", flush=True)
    print(f"[INFO] Total URLs removed: {total_removed}", flush=True)
    print("[DONE] Output ZIP ready. Contains clean_sitemaps/ + duplicates/", flush=True)


if __name__ == "__main__":
    main()
