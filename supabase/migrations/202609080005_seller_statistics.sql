-- Ejecuta una vez en Supabase > SQL Editor para habilitar estadísticas por vendedora.
begin;

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
    'totalRevenue', (select coalesce(sum(total), 0) from public.fiestas_sales),
    'totalOrders', (select count(*) from public.fiestas_sales),
    'payments', (select coalesce(jsonb_object_agg(payment, amount), '{}'::jsonb)
      from (select payment, sum(total) amount from public.fiestas_sales group by payment) totals)
  ) into result;
  return result;
end;
$$;

revoke all on function public.fiestas_snapshot() from public, anon, authenticated;
grant execute on function public.fiestas_snapshot() to anon, authenticated;

commit;
