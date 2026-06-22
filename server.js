const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const QRCode = require("./vendor/QRCode");
const QRErrorCorrectLevel = require("./vendor/QRCode/QRErrorCorrectLevel");

const PORT = Number(process.env.PORT || 3030);
const PUBLIC_DIR = path.join(__dirname, "public");
const CERT_DIR = path.join(__dirname, "certs");
const PFX_PATH = path.join(CERT_DIR, "server.pfx");
const CA_CERT_PATH = path.join(CERT_DIR, "ca.cer");
const AVERAGE_WAIT_MINUTES = 8;
const USE_HTTPS = fs.existsSync(PFX_PATH) && !process.env.PORT;
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
const TWILIO_SMS_FROM_NUMBER = String(process.env.TWILIO_SMS_FROM_NUMBER || "").trim();
const SMS_DEFAULT_COUNTRY_CODE = String(process.env.SMS_DEFAULT_COUNTRY_CODE || "").replace(/\D/g, "");

let nextToken = 1;
const queue = [];
const clients = new Map();
const ownerClients = new Set();

function getPreferredHost() {
  const interfaces = os.networkInterfaces();
  const localIp = Object.values(interfaces)
    .flat()
    .find((item) => item && item.family === "IPv4" && !item.internal);
  return localIp ? localIp.address : "localhost";
}

function getRequestProtocol(req) {
  const forwarded = String(req?.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return forwarded || (USE_HTTPS ? "https" : "http");
}

function getPublicBaseUrl(req) {
  if (req?.headers?.host) {
    return `${getRequestProtocol(req)}://${req.headers.host}`;
  }
  return `${USE_HTTPS ? "https" : "http"}://${getPreferredHost()}:${PORT}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function readTextBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function publicQueue() {
  return queue.map((party, index) => ({
    ...party,
    position: index + 1,
    estimatedWaitMinutes: index * AVERAGE_WAIT_MINUTES,
  }));
}

function findParty(token) {
  return queue.find((party) => party.token === token);
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function qrSvgFor(text) {
  const code = new QRCode(-1, QRErrorCorrectLevel.M);
  code.addData(text);
  code.make();

  const moduleCount = code.getModuleCount();
  const margin = 4;
  const size = moduleCount + margin * 2;
  let cells = "";

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (code.isDark(row, col)) {
        cells += `<rect x="${col + margin}" y="${row + margin}" width="1" height="1" />`;
      }
    }
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" aria-hidden="true">`,
    `<rect width="${size}" height="${size}" fill="#ffffff" />`,
    `<g fill="#111111">${cells}</g>`,
    `</svg>`,
  ].join("");
}

function escapeXml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]);
}

function publicUrls(req) {
  const baseUrl = getPublicBaseUrl(req);
  return {
    baseUrl,
    ownerUrl: `${baseUrl}/?view=owner`,
    customerUrl: `${baseUrl}/?view=customer`,
    qrUrl: `${baseUrl}/api/qr.svg`,
    trustQrUrl: `${baseUrl}/api/trust-qr.svg`,
    trustUrl: `${baseUrl}/trust/ca.cer`,
    secure: USE_HTTPS,
  };
}

function normalizePhoneNumber(input, defaultCountryCode = "") {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (defaultCountryCode) return `+${defaultCountryCode}${digits}`;
  return `+${digits}`;
}

function broadcastOwners() {
  const snapshot = publicQueue();
  for (const res of ownerClients) writeEvent(res, "queue", snapshot);
}

function sendToToken(token, event, data) {
  const set = clients.get(token);
  if (!set) return;
  for (const res of set) writeEvent(res, event, data);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.normalize(decodeURIComponent(url.pathname));
  if (filePath === path.sep) filePath = "index.html";
  filePath = path.join(PUBLIC_DIR, filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  });
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/queue") {
      sendJson(res, 200, publicQueue());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/meta") {
      sendJson(res, 200, publicUrls(req));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/join") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      const seats = Number(body.seats);
      const notes = String(body.notes || "").trim();

      if (!name || !phone || !Number.isInteger(seats) || seats < 1 || seats > 30) {
        sendJson(res, 400, { error: "Name, phone, and seats are required." });
        return;
      }

      const token = `A${String(nextToken++).padStart(3, "0")}`;
      const party = {
        token,
        name,
        phone,
        seats,
        notes,
        status: "waiting",
        createdAt: new Date().toISOString(),
      };
      queue.push(party);
      broadcastOwners();
      sendJson(res, 201, publicQueue().find((item) => item.token === token));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/ring/")) {
      const token = decodeURIComponent(url.pathname.split("/").pop());
      const party = findParty(token);
      if (!party) {
        sendJson(res, 404, { error: "Token not found." });
        return;
      }
      party.status = "called";
      party.calledAt = new Date().toISOString();
      sendToToken(token, "called", {
        token,
        message: "Your table is ready. Please come to the host desk.",
      });
      broadcastOwners();
      sendJson(res, 200, party);
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/seat/")) {
      const token = decodeURIComponent(url.pathname.split("/").pop());
      const index = queue.findIndex((party) => party.token === token);
      if (index === -1) {
        sendJson(res, 404, { error: "Token not found." });
        return;
      }
      const [party] = queue.splice(index, 1);
      sendToToken(token, "seated", {
        token,
        message: "Thank you. Your party has been seated.",
      });
      clients.delete(token);
      broadcastOwners();
      sendJson(res, 200, party);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/qr.svg") {
      const svg = qrSvgFor(publicUrls(req).customerUrl);
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(svg);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/trust-qr.svg") {
      const svg = qrSvgFor(publicUrls(req).trustUrl);
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(svg);
      return;
    }

    if (req.method === "GET" && url.pathname === "/trust/ca.cer") {
      if (!fs.existsSync(CA_CERT_PATH)) {
        sendJson(res, 404, { error: "Trust certificate not available." });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": 'attachment; filename="restaurant-queue-ca.cer"',
        "cache-control": "no-store",
      });
      res.end(fs.readFileSync(CA_CERT_PATH));
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const token = url.searchParams.get("token");
      const role = url.searchParams.get("role");
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      writeEvent(res, "connected", { ok: true });

      if (role === "owner") {
        ownerClients.add(res);
        writeEvent(res, "queue", publicQueue());
        req.on("close", () => ownerClients.delete(res));
        return;
      }

      if (token) {
        if (!clients.has(token)) clients.set(token, new Set());
        clients.get(token).add(res);
        const party = publicQueue().find((item) => item.token === token);
        if (party) writeEvent(res, "status", party);
        req.on("close", () => {
          const set = clients.get(token);
          if (!set) return;
          set.delete(res);
          if (!set.size) clients.delete(token);
        });
        return;
      }

      res.end();
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
}

const server = USE_HTTPS
  ? https.createServer(
      {
        pfx: fs.readFileSync(PFX_PATH),
      },
      requestHandler,
    )
  : http.createServer(requestHandler);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Restaurant Queue App`);
  console.log(`Local:   ${USE_HTTPS ? "https" : "http"}://localhost:${PORT}`);
  console.log(`Network: ${getPublicBaseUrl()}`);
  if (USE_HTTPS) {
    console.log(`Trust CA: ${CA_CERT_PATH}`);
  }
});
