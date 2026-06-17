const { createServer, get } = require("node:http");
require("dotenv").config();
const security = require("./src/lib/security");
const {
  getSearch,
  postSearch,
} = require("./src/controllers/searchControllers");
const {
  uploadFile,
  getUpload,
  getOriginalDocument,
  getOriginalDocumentBySource,
  deleteUpload,
} = require("./src/controllers/uploadFilesControllers");
const {
  login,
  createAccount,
  deleteAccount,
  getAccount,
  getSession,
  getCounties,
  getStates,
  updateAccount,
  getPendingAccounts,
  approveAccount,
  rejectAccount,
  getSecurityOverview,
  clearSecurityState,
} = require("./src/controllers/accountControllers");

const {
  uploadVideoFile,
  getVideoStatus,
  getVideoTranscript,
} = require("./src/controllers/uploadVideoControllers");

const hostname = "127.0.0.1";
const port = 1337;

const server = createServer((req, res) => {
  const requestContext = security.beginRequest(req);
  const originalEnd = res.end;
  res.end = function patchedEnd(...args) {
    if (!res.__securityLogged) {
      res.__securityLogged = true;
      security.completeRequest(req, res, requestContext);
    }
    return originalEnd.apply(this, args);
  };

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Admin-Key, X-File-Name, X-Upload-Filename",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");

  const blockInfo = security.isBlocked(req);
  if (blockInfo) {
    res.statusCode = 403;
    res.setHeader(
      "Retry-After",
      Math.ceil((blockInfo.blockedUntil - Date.now()) / 1000),
    );
    res.end(
      JSON.stringify({ error: "Request blocked due to suspicious activity" }),
    );
    return;
  }

  const rateLimit = security.checkRateLimit(req);
  if (!rateLimit.allowed) {
    res.statusCode = rateLimit.statusCode || 429;
    if (rateLimit.retryAfterSeconds) {
      res.setHeader("Retry-After", rateLimit.retryAfterSeconds);
    }
    res.end(JSON.stringify({ error: rateLimit.error || "Too many requests" }));
    return;
  }

  const path = req.url.split("?")[0];

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  try {
    if (path === "/search" && req.method === "GET") {
      getSearch(req, res);
      return;
    }

    if (path === "/search" && req.method === "POST") {
      postSearch(req, res);
      return;
    }

    if (path === "/upload" && req.method === "POST") {
      uploadFile(req, res);
      return;
    }

    if (path === "/upload" && req.method === "GET") {
      getUpload(req, res);
      return;
    }

    if (path === "/upload" && req.method === "DELETE") {
      deleteUpload(req, res);
      return;
    }

    if (path === "/upload/video" && req.method === "POST") {
      uploadVideoFile(req, res);
      return;
    }

    const videoStatusMatch = path.match(/^\/upload\/video\/([^/]+)\/status$/);
    if (videoStatusMatch && req.method === "GET") {
      getVideoStatus(req, res, decodeURIComponent(videoStatusMatch[1]));
      return;
    }

    const videoTranscriptMatch = path.match(
      /^\/upload\/video\/([^/]+)\/transcript$/,
    );
    if (videoTranscriptMatch && req.method === "GET") {
      getVideoTranscript(req, res, decodeURIComponent(videoTranscriptMatch[1]));
      return;
    }

    if (req.method === "GET") {
      const documentMatch = path.match(/^\/documents\/([^/]+)\/original$/);
      if (documentMatch) {
        getOriginalDocument(req, res, decodeURIComponent(documentMatch[1]));
        return;
      }

      if (path === "/documents/") {
        getOriginalDocumentBySource(req, res);
        return;
      }
    }

    if (path === "/account/signup" && req.method === "POST") {
      createAccount(req, res);
      return;
    }

    if (path === "/account/delete" && req.method === "DELETE") {
      deleteAccount(req, res);
      return;
    }

    if (path === "/account/login" && req.method === "POST") {
      login(req, res);
      return;
    }

    if (path === "/account/session" && req.method === "GET") {
      getSession(req, res);
      return;
    }

    if (path === "/counties" && req.method === "GET") {
      getCounties(req, res);
      return;
    }

    if (path === "/states" && req.method === "GET") {
      getStates(req, res);
      return;
    }

    if (path === "/account/update" && req.method === "PATCH") {
      updateAccount(req, res);
      return;
    }

    if (path === "/account" && req.method === "GET") {
      getAccount(req, res);
      return;
    }

    if (path === "/admin/pending" && req.method === "GET") {
      getPendingAccounts(req, res);
      return;
    }

    if (path === "/admin/approve" && req.method === "PATCH") {
      approveAccount(req, res);
      return;
    }

    if (path === "/admin/reject" && req.method === "DELETE") {
      rejectAccount(req, res);
      return;
    }

    if (path === "/admin/security" && req.method === "GET") {
      getSecurityOverview(req, res);
      return;
    }

    if (path === "/admin/security" && req.method === "DELETE") {
      clearSecurityState(req, res);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
