// GET /v1/openapi.json, GET /docs — both public, no auth. 04j (re-scope of
// 04i's reverted docs.ts). See PROJECT_PLAN.md's 04j section and
// build-report.md's 04i section for why this deliberately does NOT use
// `@hono/zod-openapi` or `OpenAPIHono`: that package's `hono/utils/url`
// import broke Vercel's Edge Function deploy-time validator, confirmed
// across every published version, and isn't fixable by pinning a different
// release.
//
// The spec below is a static JSON file generated at build time by
// `scripts/generate-openapi.ts` (`npm run generate:openapi`, also wired as
// a `prebuild` step) — this file only ever imports the already-generated
// JSON, never the generator or its `zod-to-json-schema` dependency, so
// nothing OpenAPI-related touches this route's own import graph beyond a
// plain JSON literal (resolved at bundle time, same as any other JSON
// import — no runtime file read).
//
// /docs loads Swagger UI from a CDN <script>/<link> tag rather than an npm
// package (`@hono/swagger-ui` or `swagger-ui-dist`) for the same reason:
// zero risk of a new dependency's import graph tripping the Edge validator
// again.

import { Hono } from 'hono';
import spec from './openapi.generated.json';

const router = new Hono();

router.get('/v1/openapi.json', (c) => c.json(spec));

router.get('/docs', (c) =>
  c.html(`<!doctype html>
<html>
  <head>
    <title>ad-server API docs</title>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: '/v1/openapi.json',
          dom_id: '#swagger-ui',
        });
      };
    </script>
  </body>
</html>`)
);

export default router;
