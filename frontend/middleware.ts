import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// The list of origins allowed to embed the search widget in an <iframe> is
// sourced from the backend's embed_origins table (the same table the
// /admin/embed-origins API manages) via a public, read-only endpoint. This
// keeps a single allowlist instead of an env var and the DB table drifting
// out of sync — onboarding or revoking a partner via the admin API takes
// effect here too, no redeploy required. The list is cached briefly so
// most requests don't pay for a backend round trip.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:1337";
const EMBED_ORIGINS_CACHE_TTL_MS = 60 * 1000;
const EMBED_ORIGINS_FETCH_TIMEOUT_MS = 3000;

let cachedEmbedOrigins: string[] = [];
let cachedAt = 0;

async function getAllowedEmbedOrigins(): Promise<string[]> {
    const now = Date.now();
    if (now - cachedAt < EMBED_ORIGINS_CACHE_TTL_MS) {
        return cachedEmbedOrigins;
    }

    try {
        const response = await fetch(`${API_URL}/embed-origins/allowed`, {
            signal: AbortSignal.timeout(EMBED_ORIGINS_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`Unexpected status ${response.status}`);
        }
        const data = await response.json();
        cachedEmbedOrigins = Array.isArray(data.origins) ? data.origins : [];
        cachedAt = now;
    } catch {
        // Keep serving the last known-good list on a transient failure so a
        // backend blip doesn't lock out every embed partner at once. If
        // we've never successfully fetched, fail closed ([] => 'self' only)
        // rather than open.
        if (cachedAt === 0) {
            cachedEmbedOrigins = [];
        }
    }

    return cachedEmbedOrigins;
}

export async function middleware(request: NextRequest) {
    const response = NextResponse.next();
    const isEmbeddableRoute = request.nextUrl.pathname === "/";

    if (isEmbeddableRoute) {
        const allowedEmbedOrigins = await getAllowedEmbedOrigins();
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
