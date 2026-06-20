-- Run this entire file in Supabase → SQL Editor

-- ─── Products ────────────────────────────────────────────────────────────────
create table if not exists products (
  id          bigint      primary key generated always as identity,
  cj_pid      text        unique,          -- CJ Dropshipping product ID
  cj_vid      text,                        -- CJ default variant ID (needed for orders)
  name        text        not null,
  description text,
  price       numeric     not null,        -- your selling price
  cost        numeric,                     -- CJ supplier cost
  image       text,
  category    text,
  badge       text        default 'New',
  inventory   int         default 0,
  active      boolean     default true,
  created_at  timestamptz default now()
);

-- ─── Orders ──────────────────────────────────────────────────────────────────
create table if not exists orders (
  id                    bigint      primary key generated always as identity,
  stripe_session_id     text        unique,
  stripe_payment_intent text,
  customer_name         text,
  customer_email        text,
  customer_phone        text,
  customer_address      text,
  customer_city         text,
  customer_state        text,
  customer_zip          text,
  items                 jsonb       not null,   -- array of { name, price, cj_vid }
  total                 numeric,
  status                text        default 'Pending Payment',
  supplier              text,
  tracking              text,
  cj_order_id           text,
  created_at            timestamptz default now()
);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table products enable row level security;
alter table orders   enable row level security;

-- Anyone can read active products (storefront)
create policy "Public read active products"
  on products for select
  using (active = true);

-- Service role key (used by server.js) bypasses RLS automatically.
-- No other policies needed — the server handles all writes.
