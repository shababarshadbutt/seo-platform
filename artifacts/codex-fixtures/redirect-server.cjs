const http = require("http");

const port = 41236;
const body = "<!doctype html><html><body>" + "Real content ".repeat(300) + "</body></html>";

http
  .createServer((req, res) => {
    const url = req.url || "/";

    if (url.startsWith("/industrial-automation/")) {
      res.statusCode = 301;
      res.setHeader("location", url.replace("/industrial-automation", ""));
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    res.end(body);
  })
  .listen(port, "0.0.0.0");
