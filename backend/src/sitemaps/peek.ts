import { createReadStream } from "node:fs";

import sax from "sax";

function localName(name: string) {
  return name.split(":").pop()?.toLowerCase() ?? name.toLowerCase();
}

export async function peekRootElement(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(filePath, {
      start: 0,
      end: 2047,
      encoding: "utf8"
    });
    const parser = sax.parser(true, {});
    let rootElement: string | null = null;
    let settled = false;

    function settle(rootElement: string | null) {
      if (settled) {
        return;
      }

      settled = true;
      stream.destroy();
      resolve(rootElement);
    }

    parser.onopentag = (node) => {
      rootElement ??= localName(node.name);
    };

    parser.onerror = () => {
      (parser as unknown as { error: Error | null }).error = null;
      parser.resume();
      settle(rootElement);
    };

    stream.on("data", (chunk) => {
      if (settled) {
        return;
      }

      try {
        parser.write(String(chunk));
      } catch {
        settle(rootElement);
      }
    });

    stream.on("error", () => {
      settle(rootElement);
    });

    stream.on("end", () => {
      if (settled) {
        return;
      }

      try {
        parser.close();
      } catch {
        settle(rootElement);
        return;
      }

      settle(rootElement);
    });
  });
}
