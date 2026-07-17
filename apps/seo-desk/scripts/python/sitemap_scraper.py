#!/usr/bin/env python3
"""
Sitemap Scraper
Accepts one or more robots.txt URLs, extracts parent sitemaps from each,
then fetches all child sitemaps from those parents.
"""
import argparse
import xml.etree.ElementTree as ET

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


COMMON_SITEMAP_PATHS = [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/sitemap-index.xml",
    "/sitemap/sitemap.xml",
    "/sitemaps/sitemap.xml",
    "/sitemap/index.xml",
    "/wp-sitemap.xml",
    "/news-sitemap.xml",
    "/product-sitemap.xml",
    "/page-sitemap.xml",
]


def get_sitemaps_from_robots(url):
    print(f"[INFO] Fetching robots.txt: {url}")

    # Derive base URL from robots.txt URL
    from urllib.parse import urlparse
    parsed = urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    try:
        response = session.get(url, timeout=15)
        response.raise_for_status()
        sitemap_urls = []
        for line in response.text.splitlines():
            line = line.strip()
            if line.lower().startswith("sitemap:"):
                sitemap_url = line.split(":", 1)[1].strip()
                sitemap_urls.append(sitemap_url)

        if sitemap_urls:
            print(f"[INFO] Found {len(sitemap_urls)} parent sitemap(s) in robots.txt")
            return sitemap_urls

        # No sitemaps in robots.txt — print content for debugging
        print(f"[WARN] No Sitemap: directive found in robots.txt. Content preview:")
        for line in response.text.splitlines()[:10]:
            if line.strip():
                print(f"       {line.strip()}")

        # Try common paths
        print(f"[INFO] Trying common sitemap paths on {base_url}...")
        for path in COMMON_SITEMAP_PATHS:
            candidate = base_url + path
            try:
                r = session.get(candidate, timeout=10)
                if r.status_code == 200 and ("xml" in r.headers.get("Content-Type", "") or r.text.strip().startswith("<")):
                    print(f"[INFO] Found sitemap at: {candidate}")
                    sitemap_urls.append(candidate)
                    break
                else:
                    print(f"[INFO] {candidate} → {r.status_code}")
            except Exception as e:
                print(f"[INFO] {candidate} → error: {e}")

        if not sitemap_urls:
            print(f"[WARN] No sitemaps found via robots.txt or common paths for {base_url}")

        return sitemap_urls

    except Exception as e:
        print(f"[ERROR] Failed to fetch robots.txt {url}: {e}")
        return []


def get_child_sitemaps(url):
    if url.endswith(".xml"):
        return parse_xml_sitemap(url)
    elif url.endswith(".txt"):
        print(f"[INFO] Reading TXT sitemap index: {url}")
        try:
            response = session.get(url, timeout=15)
            response.raise_for_status()
            return [line.strip() for line in response.text.splitlines() if line.strip()]
        except Exception as e:
            print(f"[ERROR] Failed to read TXT sitemap {url}: {e}")
            return []
    else:
        # Try XML anyway
        return parse_xml_sitemap(url)


def parse_xml_sitemap(url):
    print(f"[INFO] Parsing XML sitemap index: {url}")
    try:
        response = session.get(url, timeout=15)
        response.raise_for_status()
        # Detect Cloudflare HTML challenge instead of XML
        content = response.content
        if content.strip().startswith(b"<!DOCTYPE") or content.strip().startswith(b"<html"):
            print(f"[ERROR] {url} is returning an HTML page (bot protection). Whitelist your server IP in Cloudflare.")
            return []
        root = ET.fromstring(content)
        namespace = {"ns": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        children = []
        for sitemap in root.findall("ns:sitemap", namespace):
            loc = sitemap.find("ns:loc", namespace)
            if loc is not None:
                children.append(loc.text.strip())
        print(f"[INFO] Found {len(children)} child sitemap(s) in {url}")
        return children
    except Exception as e:
        print(f"[ERROR] Failed to parse XML sitemap {url}: {e}")
        return []


def main():
    parser = argparse.ArgumentParser(description="Sitemap Scraper")
    parser.add_argument("--robots_urls", required=True,
                        help="Newline-separated robots.txt URLs")
    parser.add_argument("--output_file", default="",
                        help="Path to save the output TXT file")
    args = parser.parse_args()

    robots_urls = [u.strip() for u in args.robots_urls.splitlines() if u.strip()]

    print(f"[INFO] Processing {len(robots_urls)} robots.txt URL(s)...\n")

    all_sitemaps = set()

    for robots_url in robots_urls:
        parent_sitemaps = get_sitemaps_from_robots(robots_url)
        if not parent_sitemaps:
            print(f"[WARN] No sitemaps found in {robots_url}")
            continue

        for parent in parent_sitemaps:
            all_sitemaps.add(parent)

    if not all_sitemaps:
        print("[ERROR] No sitemaps found.")
        return

    sorted_sitemaps = sorted(all_sitemaps)
    print(f"\n[INFO] Total unique sitemaps extracted: {len(sorted_sitemaps)}\n")
    for sm in sorted_sitemaps:
        print(sm)

    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            for sm in sorted_sitemaps:
                f.write(sm + "\n")
        print(f"\n[DONE] Completed — {len(sorted_sitemaps)} sitemaps. File saved.")
    else:
        print(f"\n[DONE] Completed — {len(sorted_sitemaps)} sitemaps listed above.")


if __name__ == "__main__":
    main()
