const http = require("http");

const port = 41234;

const server = http.createServer((req, res) => {
  if (req.url === "/soft-page") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    res.end(
      "<!doctype html><html><body><main>No entity selected</main></body></html>"
    );
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(`<!doctype html><html><body>${"Real content ".repeat(300)}</body></html>`);
});

server.listen(port, "0.0.0.0");
