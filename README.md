# CountyWyde

CountyWyde is a county records search application with a public frontend and a backend API. The frontend can be embedded into a county website with an iframe so the county can offer a search widget without exposing the full CountyWyde application.

## API documentation

The backend OpenAPI specification is maintained in [backend/openapi.yaml](backend/openapi.yaml). It documents the authenticated account flows, upload endpoints, video processing routes, and public search contract used by the application.

## Document integrations

Signed-in, approved county accounts can keep their documents in sync from **Account → Integrations**:

- **Monitor your website (no code):** register a page that lists documents, an RSS feed, a sitemap, or a direct file link. The backend checks it every 6 hours, daily, or weekly (`backend/src/lib/sourceCrawler.js`), ingests new PDF/DOCX/CSV/TXT/JSON files, and re-indexes files whose content changed. At most 25 new files are ingested per check, so large back-catalogs load over several runs.
- **Developer API:** create a county API key and call `POST/GET/DELETE /api/v1/documents` with `Authorization: Bearer <key>`. Keys are stored hashed, scoped to the creator's county, and stop working if revoked or if the creator's account leaves that county.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCUMENT_MONITOR_ENABLED` | `true` | Set to `false` to stop the scheduled website checks on this instance. |
| `INTEGRATIONS_ALLOW_PRIVATE_URLS` | `false` | Dev/test only (ignored in production): lets monitored URLs point at localhost. |

## Public frontend URL

Use the public frontend URL, not the backend API endpoint.

Example:

```text
https://your-countywyde-site.com/
```

## Iframe embed pattern

A county website can embed the search UI by setting the `embed` query parameter and passing the county/state values.

```html
<iframe
  src="https://your-countywyde-site.com/?embed=1&state=TX&county=Travis"
  width="100%"
  height="700"
  title="CountyWyde search"
  loading="lazy"
></iframe>
```

### Supported query params

- `embed=1` — enables embedded mode
- `state=<state abbreviation>` — sets the state value
- `county=<county name>` — sets the county value

Example with a different county:

```html
<iframe
  src="https://your-countywyde-site.com/?embed=1&state=CA&county=Los Angeles"
  width="100%"
  height="700"
  title="CountyWyde search"
></iframe>
```

## Notes

- The iframe should point to the frontend application URL, not the backend `/search` API route.
- The frontend page reads `embed`, `state`, and `county` from the query string and pre-populates them.
- This keeps the embed flow compatible with county websites while preserving the CountyWyde search logic in one place.
- If the county wants a cleaner embedded widget, they can hide the surrounding navigation/header in the embedded variation or use a styled wrapper around the iframe.

## Example implementation

```html
<div class="countywyde-widget">
  <iframe
    src="https://your-countywyde-site.com/?embed=1&state=TX&county=Travis"
    width="100%"
    height="720"
    title="CountyWyde Search"
    style="border: 0; width: 100%; min-height: 720px;"
  ></iframe>
</div>
```

## Current frontend behavior

The homepage currently checks for `embed=1` and uses the existing search params flow to initialize the county/state selection. The logic is implemented in the frontend home page and expects the embed widget to be launched with the appropriate query string values.
