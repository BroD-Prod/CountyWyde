import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Comma-separated list of origins (e.g. "https://partner1.com,https://partner2.com")
// allowed to embed the search widget in an <iframe>. Configure via Railway env vars.
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
