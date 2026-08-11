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
  verifyTwoFactor,
  resendTwoFactor,
  requestAccountAccess,
  createAccount,
  deleteAccount,
  getAccount,
  getSession,
  getCounties,
  getStates,
  updateAccount,
  changePassword,
  requestPasswordReset,
  resetPasswordWithToken,
  getPendingAccounts,
  approveAccount,
  rejectAccount,
  getPendingAccountRequests,
  approveAccountRequest,
  rejectAccountRequest,
  getSecurityOverview,
  clearSecurityState,
} = require("./src/controllers/accountControllers");

const {
  uploadVideoFile,
  getVideoStatus,
  getVideoTranscript,
  getVideoFile,
} = require("./src/controllers/uploadVideoControllers");

const hostname = process.env.HOSTNAME || "127.0.0.1";
const port = Number(process.env.PORT || 1337);
const configuredFrontendOrigin = String(
  process.env.FRONTEND_ORIGIN || process.env.ALLOWED_ORIGIN || "",
).trim();
const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    configuredFrontendOrigin,
  ].filter(Boolean),
);
// --- AI Search Rate Limiter ---
const searchRateWindow = new Map();
const SEARCH_RATE_LIMIT = 5; // Max 5 searches
const SEARCH_WINDOW_MS = 60 * 1000; // Per 60 seconds (1 minute)

function getClientIp(req) {
  // Respect proxies/load balancers if you are hosting on AWS/Render/Heroku, otherwise fallback to socket IP
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function checkSearchRateLimit(req, res) {
  const now = Date.now();
  const ip = getClientIp(req);
  const state = searchRateWindow.get(ip);

  // If new IP or the window has expired, reset their count
  if (!state || state.resetAt <= now) {
    searchRateWindow.set(ip, { count: 1, resetAt: now + SEARCH_WINDOW_MS });
    return false; // Allowed
  }

  state.count += 1;
  if (state.count > SEARCH_RATE_LIMIT) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Retry-After", Math.ceil((state.resetAt - now) / 1000));
    res.end(
      JSON.stringify({
        error: "Too many search requests. Please wait a minute and try again.",
      }),
    );
    return true; // Blocked
  }

  return false; // Allowed
}

const server = createServer(async (req, res) => {
  const requestContext = security.beginRequest(req);
  const originalEnd = res.end;
  res.end = function patchedEnd(...args) {
    if (!res.__securityLogged) {
      res.__securityLogged = true;
      void security.completeRequest(req, res, requestContext);
    }
    return originalEnd.apply(this, args);
  };

  res.setHeader("Content-Type", "application/json");
  const requestOrigin = String(req.headers.origin || "").trim();
  const resolvedOrigin = allowedOrigins.has(requestOrigin)
    ? requestOrigin
    : "http://localhost:3000";
  res.setHeader("Access-Control-Allow-Origin", resolvedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Admin-Key, X-File-Name, X-Upload-Filename, X-Video-Created-At",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const blockInfo = await security.isBlocked(req);
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

  const rateLimit = await security.checkRateLimit(req);
  if (!rateLimit.allowed) {
    res.statusCode = rateLimit.statusCode || 429;
    if (rateLimit.retryAfterSeconds) {
      res.setHeader("Retry-After", rateLimit.retryAfterSeconds);
    }
    res.end(JSON.stringify({ error: rateLimit.error || "Too many requests" }));
    return;
  }

  const path = req.url.split("?")[0];

  try {
    if (path === "/search" && req.method === "GET") {
      await getSearch(req, res);
      return;
    }

    if (path === "/search" && req.method === "POST") {
      if (checkSearchRateLimit(req, res)) {
        return;
      }
      await postSearch(req, res);
      return;
    }

    if (path === "/upload" && req.method === "POST") {
      await uploadFile(req, res);
      return;
    }

    if (path === "/upload" && req.method === "GET") {
      await getUpload(req, res);
      return;
    }

    if (path === "/upload" && req.method === "DELETE") {
      await deleteUpload(req, res);
      return;
    }

    if (path === "/upload/video" && req.method === "POST") {
      await uploadVideoFile(req, res);
      return;
    }

    const videoStatusMatch = path.match(/^\/upload\/video\/([^/]+)\/status$/);
    if (videoStatusMatch && req.method === "GET") {
      await getVideoStatus(req, res, decodeURIComponent(videoStatusMatch[1]));
      return;
    }

    const videoTranscriptMatch = path.match(
      /^\/upload\/video\/([^/]+)\/transcript$/,
    );
    if (videoTranscriptMatch && req.method === "GET") {
      await getVideoTranscript(req, res, decodeURIComponent(videoTranscriptMatch[1]));
      return;
    }

    const videoFileMatch = path.match(/^\/upload\/video\/([^/]+)\/original$/);
    if (videoFileMatch && req.method === "GET") {
      getVideoFile(req, res, decodeURIComponent(videoFileMatch[1]));
      return;
    }

    if (req.method === "GET") {
      const documentMatch = path.match(/^\/documents\/([^/]+)\/original$/);
      if (documentMatch) {
        await getOriginalDocument(req, res, decodeURIComponent(documentMatch[1]));
        return;
      }

      if (path === "/documents/") {
        await getOriginalDocumentBySource(req, res);
        return;
      }
    }

    if (path === "/account/signup" && req.method === "POST") {
      await createAccount(req, res);
      return;
    }

    if (path === "/account/request-access" && req.method === "POST") {
      await requestAccountAccess(req, res);
      return;
    }

    if (path === "/account/delete" && req.method === "DELETE") {
      await deleteAccount(req, res);
      return;
    }

    if (path === "/account/login" && req.method === "POST") {
      await login(req, res);
      return;
    }

    if (path === "/account/2fa/verify" && req.method === "POST") {
      await verifyTwoFactor(req, res);
      return;
    }

    if (path === "/account/2fa/resend" && req.method === "POST") {
      await resendTwoFactor(req, res);
      return;
    }

    if (path === "/account/session" && req.method === "GET") {
      await getSession(req, res);
      return;
    }

    if (path === "/counties" && req.method === "GET") {
      await getCounties(req, res);
      return;
    }

    if (path === "/states" && req.method === "GET") {
      await getStates(req, res);
      return;
    }

    if (path === "/account/update" && req.method === "PATCH") {
      await updateAccount(req, res);
      return;
    }

    if (path === "/account/password" && req.method === "PATCH") {
      await changePassword(req, res);
      return;
    }

    if (path === "/account/password/forgot" && req.method === "POST") {
      await requestPasswordReset(req, res);
      return;
    }

    if (path === "/account/password/reset" && req.method === "POST") {
      await resetPasswordWithToken(req, res);
      return;
    }

    if (path === "/account" && req.method === "GET") {
      await getAccount(req, res);
      return;
    }

    if (path === "/admin/pending" && req.method === "GET") {
      await getPendingAccounts(req, res);
      return;
    }

    if (path === "/admin/account-requests" && req.method === "GET") {
      await getPendingAccountRequests(req, res);
      return;
    }

    if (path === "/admin/account-requests/approve" && req.method === "PATCH") {
      await approveAccountRequest(req, res);
      return;
    }

    if (path === "/admin/account-requests/reject" && req.method === "DELETE") {
      await rejectAccountRequest(req, res);
      return;
    }

    if (path === "/admin/approve" && req.method === "PATCH") {
      await approveAccount(req, res);
      return;
    }

    if (path === "/admin/reject" && req.method === "DELETE") {
      await rejectAccount(req, res);
      return;
    }

    if (path === "/admin/security" && req.method === "GET") {
      await getSecurityOverview(req, res);
      return;
    }

    if (path === "/admin/security" && req.method === "DELETE") {
      await clearSecurityState(req, res);
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
