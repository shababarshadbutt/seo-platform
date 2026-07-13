import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

const targetWs = process.env.BUG2_TARGET_WS;
const fixtureDir =
  process.env.BUG2_FIXTURE_DIR ??
  "E:\\tkxel\\projects\\Servies\\Sitemap_Migration\\artifacts\\bug2-folder-fixture";

if (!targetWs) {
  throw new Error("BUG2_TARGET_WS is required");
}

const fixtureFiles = ["folder-a.xml", "folder-b.xml", "ignore-me.txt"].map(
  (fileName) => path.win32.join(fixtureDir, fileName)
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpSocket {
  constructor(wsUrl) {
    this.url = new URL(wsUrl);
    this.buffer = Buffer.alloc(0);
    this.callbacks = new Map();
    this.nextId = 1;
  }

  async connect() {
    this.socket = net.createConnection({
      host: this.url.hostname,
      port: Number(this.url.port)
    });

    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });

    const key = crypto.randomBytes(16).toString("base64");
    const request = [
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: ${this.url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Origin: http://${this.url.host}`,
      "",
      ""
    ].join("\r\n");

    this.socket.write(request);

    const leftover = await this.readHandshake();
    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("close", () => this.rejectPending("CDP socket closed"));
    this.socket.on("error", (error) => this.rejectPending(error.message));

    if (leftover.length > 0) {
      this.handleData(leftover);
    }
  }

  readHandshake() {
    return new Promise((resolve, reject) => {
      let handshakeBuffer = Buffer.alloc(0);

      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
      };

      const onError = (error) => {
        cleanup();
        reject(error);
      };

      const onData = (chunk) => {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");

        if (headerEnd === -1) {
          return;
        }

        cleanup();
        const header = handshakeBuffer.slice(0, headerEnd).toString("utf8");

        if (!header.includes(" 101 ")) {
          reject(new Error(`WebSocket handshake failed: ${header}`));
          return;
        }

        resolve(handshakeBuffer.slice(headerEnd + 4));
      };

      this.socket.on("data", onData);
      this.socket.on("error", onError);
    });
  }

  rejectPending(reason) {
    for (const { reject, timeout } of this.callbacks.values()) {
      clearTimeout(timeout);
      reject(new Error(reason));
    }

    this.callbacks.clear();
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }

        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }

        payloadLength = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskLength = isMasked ? 4 : 0;
      const frameLength = offset + maskLength + payloadLength;

      if (this.buffer.length < frameLength) {
        return;
      }

      let mask;

      if (isMasked) {
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      let payload = this.buffer.slice(offset, offset + payloadLength);
      this.buffer = this.buffer.slice(frameLength);

      if (mask) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      if (opcode === 0x1) {
        this.handleMessage(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.rejectPending("CDP socket closed by Chrome");
      } else if (opcode === 0x9) {
        this.sendFrame(payload, 0x0a);
      }
    }
  }

  handleMessage(text) {
    const message = JSON.parse(text);

    if (!message.id || !this.callbacks.has(message.id)) {
      return;
    }

    const { resolve, reject, timeout } = this.callbacks.get(message.id);
    clearTimeout(timeout);
    this.callbacks.delete(message.id);

    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
      return;
    }

    resolve(message.result);
  }

  sendFrame(payload, opcode = 0x1) {
    const payloadBuffer = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload, "utf8");
    const mask = crypto.randomBytes(4);
    let header;

    if (payloadBuffer.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payloadBuffer.length;
    } else if (payloadBuffer.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payloadBuffer.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
    }

    const maskedPayload = Buffer.from(
      payloadBuffer.map((byte, index) => byte ^ mask[index % 4])
    );

    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  send(method, params = {}) {
    const id = this.nextId++;

    this.sendFrame(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 10000);

      this.callbacks.set(id, { resolve, reject, timeout });
    });
  }

  close() {
    this.socket.end();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
  }

  return result.result.value;
}

const cdp = new CdpSocket(targetWs);
await cdp.connect();

try {
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: "http://localhost:3010" });

  let ready = false;

  for (let i = 0; i < 100; i += 1) {
    try {
      ready = await evaluate(
        cdp,
        `Boolean(document.querySelector('[data-testid="sitemap-folder-input"]')) && document.readyState !== 'loading'`
      );
    } catch {
      ready = false;
    }

    if (ready) {
      break;
    }

    await delay(250);
  }

  if (!ready) {
    throw new Error("Upload page did not render the folder input");
  }

  let domState;

  for (let i = 0; i < 40; i += 1) {
    domState = await evaluate(
      cdp,
      `(() => {
        const file = document.querySelector('[data-testid="sitemap-file-input"]');
        const folder = document.querySelector('[data-testid="sitemap-folder-input"]');
        const attrs = (input) => input ? ({
          exists: true,
          multipleAttr: input.hasAttribute('multiple'),
          multipleProp: input.multiple,
          directoryAttr: input.hasAttribute('directory'),
          webkitdirectoryAttr: input.hasAttribute('webkitdirectory'),
          type: input.getAttribute('type'),
          name: input.getAttribute('name')
        }) : { exists: false };

        return {
          title: document.title,
          file: attrs(file),
          folder: attrs(folder),
          sameNode: file === folder,
          uploadFolderButtons: Array.from(document.querySelectorAll('button')).filter((button) => button.textContent.trim() === 'Upload folder').length
        };
      })()`
    );

    if (
      domState.folder.webkitdirectoryAttr &&
      domState.folder.directoryAttr &&
      domState.folder.multipleAttr
    ) {
      break;
    }

    await delay(250);
  }

  await evaluate(
    cdp,
    `(() => {
      window.__folderInputClickCount = 0;
      const folder = document.querySelector('[data-testid="sitemap-folder-input"]');
      folder.addEventListener('click', () => { window.__folderInputClickCount += 1; });
      return true;
    })()`
  );

  await evaluate(
    cdp,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent.trim() === 'Upload folder');
      button.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`
  );
  await delay(100);

  const buttonRect = await evaluate(
    cdp,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent.trim() === 'Upload folder');
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
    })()`
  );

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: buttonRect.x,
    y: buttonRect.y
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: buttonRect.x,
    y: buttonRect.y,
    button: "left",
    clickCount: 1
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: buttonRect.x,
    y: buttonRect.y,
    button: "left",
    clickCount: 1
  });

  const clickCount = await evaluate(cdp, "window.__folderInputClickCount");

  const documentNode = await cdp.send("DOM.getDocument", {
    depth: -1,
    pierce: true
  });
  const folderNode = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: '[data-testid="sitemap-folder-input"]'
  });

  if (!folderNode.nodeId) {
    throw new Error("Folder input node not found");
  }

  const readAndDispatchFolderInput = () =>
    evaluate(
      cdp,
      `(() => {
        const folder = document.querySelector('[data-testid="sitemap-folder-input"]');
        const names = Array.from(folder.files).map((file) => file.name);
        folder.dispatchEvent(new Event('input', { bubbles: true }));
        folder.dispatchEvent(new Event('change', { bubbles: true }));
        return { length: folder.files.length, names };
      })()`
    );

  await cdp.send("DOM.setFileInputFiles", {
    nodeId: folderNode.nodeId,
    files: [fixtureDir]
  });

  let fileInputState = await readAndDispatchFolderInput();

  if (fileInputState.length === 0) {
    await cdp.send("DOM.setFileInputFiles", {
      nodeId: folderNode.nodeId,
      files: fixtureFiles
    });

    fileInputState = await readAndDispatchFolderInput();
  }

  const folderInputAfterSet = await evaluate(
    cdp,
    `(() => {
      const folder = document.querySelector('[data-testid="sitemap-folder-input"]');
      return {
        length: folder.files.length,
        names: Array.from(folder.files).map((file) => file.name),
        relativePaths: Array.from(folder.files).map((file) => file.webkitRelativePath)
      };
    })()`
  );

  let folderUi;

  for (let i = 0; i < 40; i += 1) {
    folderUi = await evaluate(
      cdp,
      `(() => {
        const text = document.body.innerText;

        return {
          foundCount: text.includes('Found 2 XML files in folder'),
          selectedCount: text.includes('2 XML files selected'),
          hasXmlA: text.includes('folder-a.xml'),
          hasXmlB: text.includes('folder-b.xml'),
          hasTxt: text.includes('ignore-me.txt')
        };
      })()`
    );

    if (
      folderUi.foundCount &&
      folderUi.selectedCount &&
      folderUi.hasXmlA &&
      folderUi.hasXmlB
    ) {
      break;
    }

    await delay(250);
  }

  if (
    !domState.file.multipleAttr ||
    domState.file.directoryAttr ||
    domState.file.webkitdirectoryAttr ||
    !domState.folder.multipleAttr ||
    !domState.folder.directoryAttr ||
    !domState.folder.webkitdirectoryAttr ||
    domState.sameNode
  ) {
    throw new Error("Rendered file inputs do not have the expected attributes");
  }

  if (clickCount < 1) {
    throw new Error("Upload folder button did not trigger the folder input");
  }

  if (
    !folderUi.foundCount ||
    !folderUi.selectedCount ||
    !folderUi.hasXmlA ||
    !folderUi.hasXmlB ||
    folderUi.hasTxt
  ) {
    throw new Error(
      `Folder input did not list exactly the XML files: ${JSON.stringify(
        { fileInputState, folderInputAfterSet, folderUi },
        null,
        2
      )}`
    );
  }

  console.log(
    JSON.stringify(
      {
        domState,
        buttonRect,
        clickCount,
        fileInputState,
        folderInputAfterSet,
        folderUi
      },
      null,
      2
    )
  );
} finally {
  cdp.close();
}
