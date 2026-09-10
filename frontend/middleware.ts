import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Comma-separated list of origins (e.g. "https://partner1.com,https://partner2.com")
// allowed to embed the search widget in an <iframe>. Configure via Railway env vars.
//
// This is a SEPARATE allowlist from the backend's embed_origins table (managed
// via the /admin/embed-origins API): this one controls who can FRAME the
// widget at all (CSP), while embed_origins controls which county a framed
// widget's searches are scoped to. Adding or revoking a partner via the
// admin API does not update this env var — do both, and redeploy this app,
// or a newly-added partner's iframe won't load / a revoked partner's iframe
// will still load (though its searches will now correctly be rejected by
// the backend once the embed_origins row is revoked).
const allowedEmbedOrigins = String(process.env.EMBED_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export function middleware(request: NextRequest) {
    const response = NextResponse.next();
    const isEmbeddableRoute = request.nextUrl.pathname === "/";

    if (isEmbeddableRoute) {
        const frameAncestors =
            allowedEmbedOrigins.length > 0
                ? `'self' ${allowedEmbedOrigins.join(" ")}`
                : "'self'";
        response.headers.set(
            "Content-Security-Policy",
            `frame-ancestors ${frameAncestors};`,
        );
    } else {
        // Non-search pages (admin, account, upload, etc.) should never be framed.
        response.headers.set("Content-Security-Policy", "frame-ancestors 'none';");
        response.headers.set("X-Frame-Options", "DENY");
    }

    return response;
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
