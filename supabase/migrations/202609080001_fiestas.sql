-- Run once in the Supabase SQL Editor. No existing tables are removed.
begin;

create function public.fiestas_clean_rut(value text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(value, ''), '[.[:space:]-]', '', 'g'));
$$;

create function public.fiestas_valid_rut(value text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare r text := public.fiestas_clean_rut(value); total integer := 0;
  factor integer := 2; digit integer; expected text; i integer;
begin
  if r !~ '^[1-9][0-9]{6,7}[0-9K]$' then return false; end if;
  for i in reverse length(r)-1..1 loop
    total := total + substring(r, i, 1)::integer * factor;
    factor := case when factor = 7 then 2 else factor + 1 end;
  end loop;
  digit := 11 - (total % 11);
  expected := case digit when 11 then '0' when 10 then 'K' else digit::text end;
  return right(r, 1) = expected;
end;
$$;

create table public.fiestas_attendees (
  id uuid primary key default gen_random_uuid(),
  rut text not null unique check (rut = public.fiestas_clean_rut(rut) and public.fiestas_valid_rut(rut)),
  nombre text not null check (length(trim(nombre)) between 1 and 120),
  carrera text not null check (length(trim(carrera)) between 1 and 120),
  tragos integer not null default 0 check (tragos between 0 and 3),
  created_at timestamptz not null default now()
);

create table public.fiestas_products (
  id text primary key, name text not null,
  price integer not null check (price > 0),
  pair_price integer check (pair_price > 0),
  icon text not null, drinks integer not null check (drinks in (0, 1)),
  active boolean not null default true, position integer not null
);

insert into public.fiestas_products(id, name, price, pair_price, icon, drinks, position) values
('empanada-pino', 'Empanada de pino', 2800, null, '🥟', 0, 1),
('empanada-queso', 'Empanada de queso', 2500, null, '🧀', 0, 2),
('mote', 'Mote con huesillo', 2500, null, '🥤', 0, 3),
('choripan', 'Choripán', 2000, null, '🌭', 0, 4),
('anticucho', 'Anticucho', 4000, 7000, '🍢', 0, 5),
('terremoto', 'Terremoto', 4000, 7000, '🍹', 1, 6),
('bebida-200', 'Bebida 200 ml', 300, null, '🥤', 0, 7),
('bebida-500', 'Bebida 500 ml', 500, null, '🥤', 0, 8);

create table public.fiestas_sales (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  items jsonb not null,
  total integer not null check (total > 0),
  attendee_id uuid references public.fiestas_attendees(id),
  rut text,
  payment text not null check (payment in ('efectivo', 'transferencia', 'tarjeta')),
  seller text not null check (length(trim(seller)) between 3 and 120),
  created_at timestamptz not null default now()
);

create table public.fiestas_drink_movements (
  id uuid primary key default gen_random_uuid(),
  attendee_id uuid not null references public.fiestas_attendees(id),
  quantity integer not null check (quantity between 1 and 3),
  source text not null check (source in ('registro', 'manual', 'venta')),
  sale_id uuid references public.fiestas_sales(id),
  created_at timestamptz not null default now()
);

create table public.fiestas_operations (
  id uuid primary key,
  kind text not null, payload jsonb not null, result jsonb not null,
  created_at timestamptz not null default now()
);

-- The public key can only call the two controlled functions below.
alter table public.fiestas_attendees enable row level security;
alter table public.fiestas_products enable row level security;
alter table public.fiestas_sales enable row level security;
alter table public.fiestas_drink_movements enable row level security;
alter table public.fiestas_operations enable row level security;
revoke all on public.fiestas_attendees, public.fiestas_products,
  public.fiestas_sales, public.fiestas_drink_movements, public.fiestas_operations from anon, authenticated;

create function public.fiestas_operate(p_key uuid, p_kind text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  previous public.fiestas_operations%rowtype;
  person public.fiestas_attendees%rowtype;
  product public.fiestas_products%rowtype;
  sale public.fiestas_sales%rowtype;
  result jsonb; items jsonb := '[]'::jsonb; item jsonb;
  rut_value text; initial integer; quantity integer; drinks integer := 0;
  amount integer; total integer := 0; seen text[] := '{}'; seller_value text;
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

  elsif p_kind = 'sale' then
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
      total := total + amount;
      drinks := drinks + quantity * product.drinks;
      items := items || jsonb_build_array(jsonb_build_object('id', product.id, 'name', product.name,
        'price', product.price, 'pair_price', product.pair_price, 'qty', quantity, 'total', amount, 'drinks', product.drinks));
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
    insert into public.fiestas_sales(items, total, attendee_id, rut, payment, seller)
      values(items, total, person.id, person.rut, p_payload->>'payment', seller_value) returning * into sale;
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

create function public.fiestas_snapshot() returns jsonb
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
    'totalRevenue', (select coalesce(sum(total), 0) from public.fiestas_sales),
    'totalOrders', (select count(*) from public.fiestas_sales),
    'payments', (select coalesce(jsonb_object_agg(payment, amount), '{}'::jsonb)
      from (select payment, sum(total) amount from public.fiestas_sales group by payment) totals)
  ) into result;
  return result;
end;
$$;

revoke all on function public.fiestas_clean_rut(text), public.fiestas_valid_rut(text),
  public.fiestas_operate(uuid, text, jsonb), public.fiestas_snapshot() from public, anon, authenticated;
grant execute on function public.fiestas_operate(uuid, text, jsonb), public.fiestas_snapshot() to anon, authenticated;

-- Realtime can read the same current data already exposed by fiestas_snapshot().
grant select on public.fiestas_attendees, public.fiestas_products, public.fiestas_sales to anon, authenticated;
create policy fiestas_realtime_attendees on public.fiestas_attendees for select to anon, authenticated using (true);
create policy fiestas_realtime_products on public.fiestas_products for select to anon, authenticated using (true);
create policy fiestas_realtime_sales on public.fiestas_sales for select to anon, authenticated using (true);
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.fiestas_attendees, public.fiestas_products, public.fiestas_sales;
  end if;
end $$;
commit;
