# ad-server

Multi-tenant ad-serving API for digital signage / DOOH inventory. See the project's Ralph Loop
docs (kept locally, gitignored) for full scope and architecture.

## Setup

```bash
npm install
cp .env.example .env   # fill in Supabase dev project values
```

## Local dev

```bash
npm run dev        # Vite frontend only, http://localhost:5173
npm run dev:api     # vercel dev — serves frontend + /api Edge functions together
```

## Test

```bash
npm test
```

## Database

Migrations live in `supabase/migrations/`. Apply with the Supabase CLI:

```bash
supabase link --project-ref <ref> --dns-resolver https
supabase db push --dns-resolver https
```

Always confirm the linked project before pushing: `cat supabase/.temp/project-ref`.

## Deploy

Feature branches → PR → `dev` → verified on the dev deploy → PR `dev` → `main` (protected,
0 required approvals). See root `CLAUDE.md` for the full deploy sequence.
