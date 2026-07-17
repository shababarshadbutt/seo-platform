import {
  Map,
  Link2,
  Upload,
  Search,
  Send,
  Clock,
  Trash2,
  BarChart3,
  Filter,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type InputType = "url" | "text" | "textarea" | "file" | "date" | "select" | "multi-site-urls";

export interface ScriptInput {
  name: string;
  label: string;
  type: InputType;
  placeholder?: string;
  description?: string;
  required: boolean;
  options?: { label: string; value: string }[];
  accept?: string;
  folder?: boolean; // enables folder/multi-file upload (webkitdirectory)
}

export interface ScriptConfig {
  slug: string;
  name: string;
  description: string;
  icon: LucideIcon;
  pythonFile: string;
  inputs: ScriptInput[];
  outputLabel?: string;
  // If true, the API route auto-fetches Google credentials from Settings and
  // passes them as --service_account_file to the Python script.
  requiresServiceAccount?: boolean;
  // If true, shows a multi-select for service accounts; runs once per selected
  // account sequentially, all output in a single terminal.
  multiServiceAccount?: boolean;
  // If set, shows an "Open Sheet" button after successful run.
  sheetUrl?: string;
}

export const scripts: ScriptConfig[] = [
  {
    slug: "sitemap-scraper",
    name: "Sitemap Scraper",
    description: "Reads robots.txt to find all sitemaps, then extracts every child sitemap URL.",
    icon: Map,
    pythonFile: "sitemap_scraper.py",
    outputLabel: "List of all child sitemap URLs",
    inputs: [
      {
        name: "robots_urls",
        label: "robots.txt URL",
        type: "url",
        placeholder: "https://example.com/robots.txt",
        description: "Enter the robots.txt URL of the website.",
        required: true,
      },
    ],
  },
  {
    slug: "url-extractor",
    name: "URL Extractor",
    description: "Extracts every page URL from a sitemap and exports them as a downloadable CSV.",
    icon: Link2,
    pythonFile: "url_extractor.py",
    outputLabel: "CSV of all page URLs",
    inputs: [
      {
        name: "sitemap_url",
        label: "Sitemap URL",
        type: "url",
        placeholder: "https://example.com/sitemap.xml",
        description: "Any sitemap URL (index or page-level).",
        required: true,
      },
    ],
  },
  {
    slug: "url-indexer",
    name: "GSC URL Indexer",
    description: "Submits URLs to Google's Indexing API. Add multiple websites at once — 200 URLs per site.",
    icon: Upload,
    pythonFile: "url_indexer.py",
    outputLabel: "Submission status per URL + CSV log",
    requiresServiceAccount: true,
    inputs: [
      {
        name: "urls",
        label: "URLs",
        type: "multi-site-urls",
        required: true,
      },
    ],
  },
  {
    slug: "bing-indexnow",
    name: "Bing URL Indexer",
    description: "Submit URLs to Bing instantly via the IndexNow protocol — no waiting for the crawler.",
    icon: Zap,
    pythonFile: "bing_indexnow.py",
    outputLabel: "Submission log CSV",
    inputs: [
      {
        name: "urls",
        label: "URLs",
        type: "multi-site-urls",
        required: true,
      },
    ],
  },
  {
    slug: "indexing-checker",
    name: "Indexing Checker",
    description: "Checks Google Search Console to verify which URLs are indexed and when they were last crawled.",
    icon: Search,
    pythonFile: "indexing_checker.py",
    outputLabel: "Index verdict + last crawl date per URL",
    requiresServiceAccount: true,
    inputs: [
      {
        name: "gsc_property",
        label: "GSC Property URL",
        type: "url",
        placeholder: "https://example.com/",
        description: "Must match exactly how the property is registered in Search Console.",
        required: true,
      },
      {
        name: "urls",
        label: "URLs to Check",
        type: "textarea",
        placeholder: "https://example.com/page-1\nhttps://example.com/page-2",
        description: "Enter one URL per line, or upload a CSV file below.",
        required: false,
      },
      {
        name: "csv_file",
        label: "Or Upload a CSV",
        type: "file",
        accept: ".csv",
        description: "CSV must have a column named 'url'.",
        required: false,
      },
    ],
  },
  {
    slug: "gsc-sitemap-submitter",
    name: "GSC Sitemap Submitter",
    description: "Bulk-submits sitemaps to a Google Search Console property.",
    icon: Send,
    pythonFile: "gsc_sitemap_submitter.py",
    outputLabel: "Submission confirmation per sitemap",
    requiresServiceAccount: true,
    inputs: [
      {
        name: "gsc_property",
        label: "GSC Property URL",
        type: "url",
        placeholder: "https://example.com/",
        description: "Must match exactly how the property is registered in Search Console.",
        required: true,
      },
      {
        name: "sitemap_urls",
        label: "Sitemap URLs",
        type: "textarea",
        placeholder: "https://example.com/sitemap.xml\nhttps://example.com/sitemap2.xml",
        description: "Enter one sitemap URL per line.",
        required: true,
      },
    ],
  },
  {
    slug: "lastmod-updater",
    name: "Lastmod Updater",
    description: "Fetches each sitemap URL, updates every <lastmod> tag to today's date, and saves the result.",
    icon: Clock,
    pythonFile: "lastmod_updater.py",
    outputLabel: "Updated XML files saved to server",
    inputs: [
      {
        name: "sitemap_urls",
        label: "Sitemap URLs",
        type: "textarea",
        placeholder: "https://example.com/sitemap1.xml\nhttps://example.com/sitemap2.xml",
        description: "Enter one sitemap URL per line. Updated files are saved to the 'updated/' folder on the server.",
        required: true,
      },
    ],
  },
  {
    slug: "sitemap-deleter",
    name: "Sitemap Deleter",
    description: "Removes specific sitemaps from a Google Search Console property.",
    icon: Trash2,
    pythonFile: "sitemap_deleter.py",
    outputLabel: "Deletion confirmation per sitemap",
    requiresServiceAccount: true,
    inputs: [
      {
        name: "gsc_property",
        label: "GSC Property URL",
        type: "url",
        placeholder: "https://example.com/",
        description: "Must match exactly how the property is registered in Search Console.",
        required: true,
      },
      {
        name: "sitemap_urls",
        label: "Sitemap URLs to Delete",
        type: "textarea",
        placeholder: "https://example.com/old-sitemap.xml\nhttps://example.com/sitemap2.xml",
        description: "Enter one sitemap URL per line.",
        required: true,
      },
    ],
  },
  {
    slug: "duplicate-sitemap-remover",
    name: "Duplicate Sitemap Remover",
    description: "Upload a ZIP of XML sitemaps — removes duplicate URLs across all files and exports clean sitemaps + a duplicates report.",
    icon: Filter,
    pythonFile: "duplicate_sitemap_remover.py",
    outputLabel: "ZIP with clean sitemaps + duplicates CSV",
    inputs: [
      {
        name: "sitemap_files",
        label: "Sitemaps Folder",
        type: "file",
        accept: ".xml",
        folder: true,
        description: "Select the folder containing your XML sitemap files.",
        required: true,
      },
    ],
  },
  {
    slug: "ga4-reporter",
    name: "GA4 Reporter",
    description: "Pulls total users from GA4 for all configured properties and writes to a Google Sheet.",
    icon: BarChart3,
    pythonFile: "ga4_reporter.py",
    outputLabel: "Traffic data written to Google Sheet",
    sheetUrl: "https://docs.google.com/spreadsheets/d/1ZQk2DZ4EN-n_L-YTyn1f0sCSQL0BzmlvyYdjTwiTEi8/edit?usp=sharing",
    inputs: [
      {
        name: "start_date",
        label: "Start Date",
        type: "date",
        required: true,
      },
      {
        name: "end_date",
        label: "End Date",
        type: "date",
        required: true,
      },
      {
        name: "sheet_name",
        label: "Google Sheet Name",
        type: "text",
        placeholder: "Weekly GA4 Report",
        description: "Exact name of the Google Sheet to write results to.",
        required: true,
      },
    ],
  },
];

export function getScriptBySlug(slug: string): ScriptConfig | undefined {
  return scripts.find((s) => s.slug === slug);
}
