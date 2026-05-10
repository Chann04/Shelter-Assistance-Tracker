# Shelter Assistance Tracker

A lightweight, single-page web app for shelter teams to record and track
client assistance requests (Housing, Food, Supplies, Medical). Built with
plain HTML, Tailwind CSS (CDN), Vanilla JavaScript (ES6+), and
[Supabase](https://supabase.com) for the backend.

## Features

- **Client intake form** — Name, ID/Phone, Category, Status
- **Live dashboard** — searchable, sortable table of all requests
- **Statistics cards** — Total Requests, Fulfilled Today, Pending Urgent
- **Real-time updates** via Supabase Realtime (other devices see changes
  instantly)
- **Inline status updates** and per-row delete
- **Mobile-responsive**, accessible UI with a soft blue/gray palette
- **Demo mode** — runs locally without Supabase keys (data won't persist)

## File structure

```
SHELTER ASSISTANCE TRACKER/
├── index.html   # Markup, Tailwind setup, Supabase loader
├── style.css    # Custom overrides (status pills, toasts, animations)
├── app.js       # Supabase client + CRUD + DOM logic
└── README.md
```

## Getting started

### 1. Create the Supabase table

In your Supabase project's **SQL Editor**, run:

```sql
create table if not exists public.assistance_requests (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  id_or_phone text not null,
  category    text not null check (category in ('Housing','Food','Supplies','Medical')),
  status      text not null default 'Pending'
                check (status in ('Pending','Approved','Fulfilled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

-- Enable Row Level Security
alter table public.assistance_requests enable row level security;

-- Demo policy: allow anyone with the anon key full access.
-- Tighten this for production (e.g. require auth.uid()).
create policy "anon full access (demo)"
  on public.assistance_requests
  for all
  using (true)
  with check (true);
```

Then enable Realtime for the table:
**Database → Replication → `supabase_realtime` publication → add
`assistance_requests`.**

> Security note: the policy above is intentionally permissive for a
> demo/internal tool. For a real deployment, gate access behind
> Supabase Auth and write policies that match your trust model.

### 2. Add your project credentials

Open `app.js` and replace the placeholders near the top:

```js
const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
```

You'll find both values in **Supabase → Project Settings → API**.

### 3. Run it

This is a static site — no build step required. You can simply open
`index.html` in a browser, but loading via a local server avoids any
module/CORS quirks:

```bash
# Python 3
python -m http.server 5500

# or with Node
npx serve .
```

Then visit http://localhost:5500.

## Usage

1. Fill out the **New Assistance Request** form and click **Add Request**.
2. The new entry appears at the top of the **Live Dashboard** table.
3. Use the search box to filter by name, ID/phone, category, or status.
4. Change status inline using the dropdown in each row — updates persist
   to Supabase and broadcast to other connected clients in real time.
5. The **Fulfilled Today** card uses `updated_at` if present, otherwise
   `created_at`.

## Tech notes

- Tailwind is loaded via CDN with a tiny inline `tailwind.config` to
  define the brand color palette. For production, build Tailwind locally
  to avoid the CDN runtime.
- The Supabase JS v2 client is loaded as an ES module from
  `cdn.jsdelivr.net` and exposed on `window.supabaseCreateClient` so
  `app.js` can use it without bundlers.
- All user-supplied strings are HTML-escaped before insertion into the
  DOM (`escapeHtml`) to mitigate XSS in the rendered table.
