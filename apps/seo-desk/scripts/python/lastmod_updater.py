#!/usr/bin/env python3
"""
Lastmod Updater
Fetches each sitemap URL, updates all <lastmod> tags to today's date (UTC),
and saves the result to the 'updated/' folder.
"""
import argparse
import requests
from lxml import etree
from datetime import datetime, timezone
import os
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

OUTPUT_FOLDER = "updated"
HEADERS = {"User-Agent": "Mozilla/5.0 (Sitemap Lastmod Updater)"}


def fetch_xml(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=20, verify=False)
        if r.status_code != 200:
            print(f"[ERROR] HTTP {r.status_code}: {url}")
            return None
        return r.content
    except Exception as e:
        print(f"[ERROR] Request failed for {url}: {e}")
        return None


def update_lastmod(url, today=None):
    if today is None:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    print(f"[INFO] Processing: {url}")
    content = fetch_xml(url)
    if content is None:
        return

    try:
        parser = etree.XMLParser(remove_blank_text=True)
        root = etree.fromstring(content, parser)
    except Exception as e:
        print(f"[ERROR] Invalid XML at {url}: {e}")
        return

    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    url_nodes = root.findall("sm:url", ns)
    sitemap_nodes = root.findall("sm:sitemap", ns)

    # Sitemap index — recurse into children
    if not url_nodes and sitemap_nodes:
        print(f"[INFO] Sitemap index detected — processing {len(sitemap_nodes)} child sitemap(s)...")
        for sitemap_node in sitemap_nodes:
            loc = sitemap_node.find("sm:loc", ns)
            if loc is not None and loc.text:
                update_lastmod(loc.text.strip(), today)
        return

    if not url_nodes:
        print(f"[WARN] No <url> or <sitemap> tags found: {url}")
        return

    for url_node in url_nodes:
        lastmod = url_node.find("sm:lastmod", ns)
        if lastmod is None:
            lastmod = etree.SubElement(
                url_node,
                "{http://www.sitemaps.org/schemas/sitemap/0.9}lastmod"
            )
        lastmod.text = today

    os.makedirs(OUTPUT_FOLDER, exist_ok=True)

    file_name = url.rstrip("/").split("/")[-1]
    if not file_name.endswith(".xml"):
        file_name += ".xml"
    output_path = os.path.join(OUTPUT_FOLDER, file_name)

    with open(output_path, "wb") as f:
        f.write(etree.tostring(
            root,
            pretty_print=True,
            xml_declaration=True,
            encoding="UTF-8"
        ))

    print(f"[INFO] Updated & saved: {os.path.abspath(output_path)}")


def main():
    parser = argparse.ArgumentParser(description="Lastmod Updater")
    parser.add_argument("--sitemap_urls", required=True,
                        help="Newline-separated sitemap URLs to update")
    args = parser.parse_args()

    urls = [u.strip() for u in args.sitemap_urls.splitlines() if u.strip()]
    if not urls:
        print("[ERROR] No sitemap URLs provided.")
        return

    print(f"[INFO] Total sitemaps to process: {len(urls)}\n")

    for url in urls:
        update_lastmod(url)

    abs_folder = os.path.abspath(OUTPUT_FOLDER)
    print(f"\n[DONE] All done. Updated files saved to: {abs_folder}")


if __name__ == "__main__":
    main()
