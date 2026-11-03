// Outbound HTTP fetcher for URLs supplied by county users (monitored sources
// and the push API's { url } mode). Because those URLs are user-controlled,
// this guards against SSRF:
//   - http/https only, default ports only
//   - every resolved address is checked against private/loopback/link-local/
//     metadata ranges *inside the socket's DNS lookup*, so the address that is
//     validated is the address that is connected to (no DNS-rebinding gap)
//   - redirects are followed manually and each hop is re-validated
//   - hard timeout and response-size cap
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");

const USER_AGENT =
  "CountyWydeBot/1.0 (+https://countywyde.com; document monitor for county websites)";
const DEFAULT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const blockList = new net.BlockList();
[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
].forEach(([address, prefix]) => blockList.addSubnet(address, prefix, "ipv4"));
[
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 can reach internal IPv4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
].forEach(([address, prefix]) => blockList.addSubnet(address, prefix, "ipv6"));

function allowPrivateNetworks() {
  // Only for local development/tests against a fixture server on localhost.
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS === "true"
  );
}

function isBlockedAddress(address) {
  if (allowPrivateNetworks()) return false;
  const family = net.isIP(address);
  if (family === 4) return blockList.check(address, "ipv4");
  if (family === 6) {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return blockList.check(mapped[1], "ipv4");
    return blockList.check(address, "ipv6");
  }
  return true;
}

class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.code = "UNSAFE_URL";
  }
}

/** Parse and validate a user-supplied URL's shape (not its DNS). */
function parsePublicUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs are supported");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  }
  if (url.port && !allowPrivateNetworks()) {
    throw new UnsafeUrlError("URLs with a custom port are not allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    if (!allowPrivateNetworks()) {
      throw new UnsafeUrlError("That address is not publicly reachable");
    }
  }
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new UnsafeUrlError("That address is not publicly reachable");
  }
  url.hash = "";
  return url;
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const safe = list.filter((entry) => !isBlockedAddress(entry.address));
    if (safe.length === 0) {
      return callback(new UnsafeUrlError("That address is not publicly reachable"));
    }
    if (options && options.all) return callback(null, safe);
    return callback(null, safe[0].address, safe[0].family);
  });
}

function requestOnce(url, { headers, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          ...headers,
        },
        lookup: guardedLookup,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: res.headers.location, status });
          return;
        }

        const declared = Number(res.headers["content-length"] || 0);
        if (declared && declared > maxBytes) {
          res.destroy();
          reject(Object.assign(new Error("File is larger than the 10 MB limit"), { code: "FILE_TOO_LARGE" }));
          return;
        }

        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(Object.assign(new Error("File is larger than the 10 MB limit"), { code: "FILE_TOO_LARGE" }));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET a public URL safely.
 * @returns {Promise<{ url: string, status: number, headers: object, body: Buffer }>}
 */
async function safeFetch(rawUrl, options = {}) {
  const {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options;

  let url = parsePublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce(url, { headers, timeoutMs, maxBytes });
    if (!result.redirect) {
      return { url: url.toString(), ...result };
    }
    url = parsePublicUrl(new URL(result.redirect, url).toString());
  }
  throw new Error("Too many redirects");
}

module.exports = {
  safeFetch,
  parsePublicUrl,
  isBlockedAddress,
  UnsafeUrlError,
  USER_AGENT,
};
