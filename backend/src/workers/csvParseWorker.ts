import { parseCsvUrlList, type CsvUrlListResult } from "../sitemaps/csvUrlList.js";

// piscina worker: parses ONE of the sitemap-regenerate wizard's uploaded CSVs
// off the BullMQ worker process's main thread, so uploading several CSVs at
// once (csvParsePool.ts) parses them in parallel instead of one at a time in
// csvUploadIngestJob.ts's loop. Thin wrapper — all the actual parsing logic
// stays in sitemaps/csvUrlList.ts, shared with any in-process caller.

export type CsvParseInput = {
  filePath: string;
};

export type CsvParseResult = CsvUrlListResult;

export default function parse(input: CsvParseInput): Promise<CsvParseResult> {
  return parseCsvUrlList(input.filePath);
}
