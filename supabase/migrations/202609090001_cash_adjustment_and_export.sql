-- Ejecuta una vez en Supabase > SQL Editor.
-- Registra una corrección de caja de -$7.100 sin modificar ventas históricas.
begin;

create table if not exists public.fiestas_adjustments (
  id text primary key,
  amount integer not null check (amount > 0),
  reason text not null check (length(trim(reason)) between 1 and 120),
  payment text not null check (payment in ('efectivo', 'transferencia', 'tarjeta')),
  created_at timestamptz not null default now()
);

alter table public.fiestas_adjustments enable row level security;
revoke all on public.fiestas_adjustments from anon, authenticated;

insert into public.fiestas_adjustments(id, amount, reason, payment)
values ('ajuste-caja-7100-20260909', 7100, 'Corrección de caja', 'efectivo')
on conflict (id) do update set amount = excluded.amount, reason = excluded.reason, payment = excluded.payment;

create or replace function public.fiestas_snapshot() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'attendees', coalesce((select jsonb_agg(a order by a.created_at desc) from public.fiestas_attendees a), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(p order by p.position) from public.fiestas_products p where active), '[]'::jsonb),
    'transactions', coalesce((select jsonb_agg(s order by s.number desc) from (select * from public.fiestas_sales order by number desc limit 50) s), '[]'::jsonb),
    'productStats', coalesce((select jsonb_agg(stat order by stat.quantity desc, stat.name)
      from (select item->>'id' id, max(item->>'name') name,
        sum((item->>'qty')::integer) quantity, sum((item->>'total')::integer) revenue
        from public.fiestas_sales cross join lateral jsonb_array_elements(items) item
        group by item->>'id') stat), '[]'::jsonb),
    'sellerStats', coalesce((select jsonb_agg(stat order by stat.revenue desc, stat.seller)
      from (select s.seller, count(*) orders, sum(s.total) revenue,
        (select coalesce(sum((item->>'qty')::integer), 0) from public.fiestas_sales sx
          cross join lateral jsonb_array_elements(sx.items) item where sx.seller = s.seller) units
        from public.fiestas_sales s group by s.seller) stat), '[]'::jsonb),
    'sellerProductStats', coalesce((select jsonb_agg(stat order by stat.seller, stat.quantity desc, stat.name)
      from (select s.seller, item->>'id' id, max(item->>'name') name,
        sum((item->>'qty')::integer) quantity, sum((item->>'total')::integer) revenue
        from public.fiestas_sales s cross join lateral jsonb_array_elements(s.items) item
        group by s.seller, item->>'id') stat), '[]'::jsonb),
    'totalRevenue', (select coalesce(sum(total), 0) from public.fiestas_sales)
      - (select coalesce(sum(amount), 0) from public.fiestas_adjustments),
    'totalOrders', (select count(*) from public.fiestas_sales),
    'payments', (select coalesce(jsonb_object_agg(payment, amount), '{}'::jsonb) from (
      select payment, sum(amount) amount from (
        select payment, total amount from public.fiestas_sales
        union all
        select payment, -amount from public.fiestas_adjustments
      ) movements group by payment
    ) totals)
  ) into result;
  return result;
end;
$$;

create or replace function public.fiestas_sales_export() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_data order by created_at), '[]'::jsonb)
  from (
    select seller, created_at, items, total
    from public.fiestas_sales
    union all
    select 'Ajuste de caja' seller, created_at,
      jsonb_build_array(jsonb_build_object('name', reason, 'qty', 1)) items,
      -amount total
    from public.fiestas_adjustments
  ) row_data;
$$;

revoke all on function public.fiestas_snapshot(), public.fiestas_sales_export() from public, anon, authenticated;
grant execute on function public.fiestas_snapshot(), public.fiestas_sales_export() to anon, authenticated;

grant select on public.fiestas_adjustments to anon, authenticated;
drop policy if exists fiestas_realtime_adjustments on public.fiestas_adjustments;
create policy fiestas_realtime_adjustments on public.fiestas_adjustments for select to anon, authenticated using (true);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'fiestas_adjustments') then
    alter publication supabase_realtime add table public.fiestas_adjustments;
  end if;
end $$;

commit;
