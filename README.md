This is a [Next.js](https://nextjs.org) app for the Cinna Tracker MVP.

## Setup

1) Create `.env.local` and set:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_TRACK_BASE_URL=http://localhost:3000
PUBLISH_JWT_SECRET=change-me
PUBLISH_JWT_TTL_HOURS=8
DEFAULT_COMPANY_ID=
```

Note: `ADMIN_JWT_SECRET` is no longer used. Sessions are handled via Supabase Auth cookies.

2) Apply database schema in Supabase SQL editor using `supabase/schema.sql`.

3) Run dev server:

```
npm run dev
```

## Admin

- Visit `/admin` to manage vehicles, generate and download QR codes.

## User

- Visit `/track?v=ONX-102` to view live map; replace code accordingly.
