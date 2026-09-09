-- Ejecuta una vez en Supabase > SQL Editor para activar las restas por producto.
begin;

create table if not exists public.fiestas_adjustments (
  id text primary key,
  amount integer not null check (amount > 0),
  reason text not null check (length(trim(reason)) between 1 and 120),
  payment text not null check (payment in ('efectivo', 'transferencia', 'tarjeta')),
  created_at timestamptz not null default now()
);

alter table public.fiestas_sales add column if not exists transaction_type text not null default 'sale';
alter table public.fiestas_sales drop constraint if exists fiestas_sales_total_check;
alter table public.fiestas_sales drop constraint if exists fiestas_sales_transaction_type_check;
alter table public.fiestas_sales add constraint fiestas_sales_total_check check (total <> 0);
alter table public.fiestas_sales add constraint fiestas_sales_transaction_type_check
  check (transaction_type in ('sale', 'subtraction'));

-- El ajuste general se reemplaza por restas detalladas para que no se descuente dos veces.
delete from public.fiestas_adjustments where id = 'ajuste-caja-7100-20260909';
create or replace function public.fiestas_operate(p_key uuid, p_kind text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  previous public.fiestas_operations%rowtype;
  person public.fiestas_attendees%rowtype;
  product public.fiestas_products%rowtype;
  sale public.fiestas_sales%rowtype;
  result jsonb; items jsonb := '[]'::jsonb; item jsonb;
  rut_value text; initial integer; quantity integer; drinks integer := 0;
  amount integer; total integer := 0; seen text[] := '{}'; seller_value text; subtracting boolean := false;
begin
  if p_key is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'Operación inválida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_key::text, 0));
  select * into previous from public.fiestas_operations where id = p_key;
  if found then
    if previous.kind <> p_kind or previous.payload <> p_payload then
      raise exception 'El identificador ya se utilizó para otra operación.';
    end if;
    return previous.result;
  end if;

  if p_kind = 'register' then
    rut_value := public.fiestas_clean_rut(p_payload->>'rut');
    if not public.fiestas_valid_rut(rut_value) then raise exception 'Ingresa un RUT chileno válido.'; end if;
    if length(trim(coalesce(p_payload->>'nombre', ''))) not between 1 and 120
      or length(trim(coalesce(p_payload->>'carrera', ''))) not between 1 and 120 then
      raise exception 'Completa el nombre y la carrera (máximo 120 caracteres).';
    end if;
    if coalesce(p_payload->>'initialTragos', '1') not in ('0', '1') then raise exception 'El registro comienza con cero o un trago.'; end if;
    initial := coalesce((p_payload->>'initialTragos')::integer, 1);
    perform pg_advisory_xact_lock(hashtextextended(rut_value, 1));
    if exists(select 1 from public.fiestas_attendees where rut = rut_value) then raise exception 'Este RUT ya está registrado. Consulta su conteo actual.'; end if;
    insert into public.fiestas_attendees(rut, nombre, carrera, tragos)
      values(rut_value, trim(p_payload->>'nombre'), trim(p_payload->>'carrera'), initial) returning * into person;
    if initial = 1 then
      insert into public.fiestas_drink_movements(attendee_id, quantity, source)
        values(person.id, 1, 'registro');
    end if;
    result := jsonb_build_object('person', to_jsonb(person));

  elsif p_kind = 'drink' then
    select * into person from public.fiestas_attendees where id = (p_payload->>'id')::uuid for update;
    if not found then raise exception 'Estudiante no encontrado.'; end if;
    if person.tragos >= 3 then raise exception 'Límite de 3 tragos alcanzado. No vender más.'; end if;
    update public.fiestas_attendees set tragos = tragos + 1 where id = person.id returning * into person;
    insert into public.fiestas_drink_movements(attendee_id, quantity, source)
      values(person.id, 1, 'manual');
    result := jsonb_build_object('person', to_jsonb(person), 'limitReachedJustNow', person.tragos = 3);

  elsif p_kind in ('sale', 'subtract') then
    subtracting := p_kind = 'subtract';
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'Comanda inválida.'; end if;
    if jsonb_array_length(p_payload->'items') not between 1 and 50 then raise exception 'Selecciona productos.'; end if;
    if coalesce(p_payload->>'payment', '') not in ('efectivo', 'transferencia', 'tarjeta') then raise exception 'Selecciona el medio de pago.'; end if;
    seller_value := trim(regexp_replace(coalesce(p_payload->>'seller', ''), '[[:space:]]+', ' ', 'g'));
    if length(seller_value) not between 3 and 120 or position(' ' in seller_value) = 0 then
      raise exception 'Ingresa el nombre y apellido de la vendedora.';
    end if;
    for item in select value from jsonb_array_elements(p_payload->'items') loop
      if coalesce(item->>'qty', '') !~ '^[1-9][0-9]{0,2}$' then raise exception 'Cantidad inválida.'; end if;
      quantity := (item->>'qty')::integer;
      if quantity > 100 then raise exception 'Máximo 100 unidades de cada producto por comanda.'; end if;
      select * into product from public.fiestas_products where id = item->>'id' and active;
      if not found or product.id = any(seen) then raise exception 'Producto inválido o repetido.'; end if;
      seen := array_append(seen, product.id);
      amount := case when product.pair_price is null then product.price * quantity
        else (quantity / 2) * product.pair_price + (quantity % 2) * product.price end;
      if subtracting then
        total := total - amount;
        items := items || jsonb_build_array(jsonb_build_object('id', product.id, 'name', product.name,
          'price', product.price, 'pair_price', product.pair_price, 'qty', -quantity, 'total', -amount, 'drinks', product.drinks));
      else
        total := total + amount;
        drinks := drinks + quantity * product.drinks;
        items := items || jsonb_build_array(jsonb_build_object('id', product.id, 'name', product.name,
          'price', product.price, 'pair_price', product.pair_price, 'qty', quantity, 'total', amount, 'drinks', product.drinks));
      end if;
    end loop;
    if drinks > 0 then
      rut_value := public.fiestas_clean_rut(p_payload->>'rut');
      if not public.fiestas_valid_rut(rut_value) then raise exception 'Ingresa un RUT válido para vender tragos con alcohol.'; end if;
      select * into person from public.fiestas_attendees where rut = rut_value for update;
      if not found then raise exception 'Registra primero al estudiante en Control de Tragos, sin sumar un trago.'; end if;
      if person.tragos + drinks > 3 then
        raise exception 'Venta bloqueada: tiene % de 3 tragos; le quedan %.', person.tragos, 3 - person.tragos;
      end if;
      update public.fiestas_attendees set tragos = tragos + drinks where id = person.id returning * into person;
    end if;
    insert into public.fiestas_sales(items, total, attendee_id, rut, payment, seller, transaction_type)
      values(items, total, person.id, person.rut, p_payload->>'payment', seller_value,
        case when subtracting then 'subtraction' else 'sale' end) returning * into sale;
    if drinks > 0 then
      insert into public.fiestas_drink_movements(attendee_id, quantity, source, sale_id)
        values(person.id, drinks, 'venta', sale.id);
    end if;
    result := jsonb_build_object('person', case when person.id is null then null else to_jsonb(person) end,
      'transaction', to_jsonb(sale), 'limitReachedJustNow', coalesce(person.tragos = 3, false));
  else
    raise exception 'Operación desconocida.';
  end if;
  insert into public.fiestas_operations(id, kind, payload, result)
    values(p_key, p_kind, p_payload, result);
  return result;
end;
$$;

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
      from (select s.seller, count(*) filter (where s.transaction_type = 'sale') orders, sum(s.total) revenue,
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
    'totalOrders', (select count(*) from public.fiestas_sales where transaction_type = 'sale'),
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
    select seller, created_at, items, total, transaction_type
    from public.fiestas_sales
    union all
    select 'Ajuste de caja' seller, created_at,
      jsonb_build_array(jsonb_build_object('name', reason, 'qty', 1)) items,
      -amount total, 'adjustment' transaction_type
    from public.fiestas_adjustments
  ) row_data;
$$;
revoke all on function public.fiestas_operate(uuid, text, jsonb), public.fiestas_snapshot(),
  public.fiestas_sales_export() from public, anon, authenticated;
grant execute on function public.fiestas_operate(uuid, text, jsonb), public.fiestas_snapshot(),
  public.fiestas_sales_export() to anon, authenticated;

commit;
