const http = require("http");

const host = "feature2-url-fixture";
const port = 41235;
const longBody = "Real content ".repeat(300);

function sitemapXml(paths) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${paths
    .map(
      (path) =>
        `<url><loc>http://${host}:${port}${path}</loc></url>`
    )
    .join("")}</urlset>`;
}

const sitemaps = new Map([
  [
    "/sitemap-a.xml",
    sitemapXml(["/catalog/a-one", "/catalog/a-two", "/catalog/a-three"])
  ],
  [
    "/sitemap-b.xml",
    sitemapXml(["/blog/post-one", "/blog/post-two", "/blog/post-three"])
  ]
]);

http
  .createServer((req, res) => {
    const sitemap = sitemaps.get(req.url ?? "");

    if (sitemap) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/xml");
      res.end(sitemap);
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    res.end(`<!doctype html><html><body>${longBody}</body></html>`);
  })
  .listen(port, "0.0.0.0");
