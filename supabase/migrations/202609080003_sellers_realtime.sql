-- Ejecuta una vez en Supabase > SQL Editor si ya instalaste la versión anterior.
begin;

alter table public.fiestas_sales add column if not exists seller text;
update public.fiestas_sales set seller = 'Sin registro' where seller is null or trim(seller) = '';
alter table public.fiestas_sales alter column seller set not null;
alter table public.fiestas_sales drop constraint if exists fiestas_sales_seller_check;
alter table public.fiestas_sales add constraint fiestas_sales_seller_check check (length(trim(seller)) between 3 and 120);

drop function if exists public.fiestas_operate(uuid, text, jsonb);
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
revoke all on function public.fiestas_operate(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.fiestas_operate(uuid, text, jsonb) to anon, authenticated;

grant select on public.fiestas_attendees, public.fiestas_products, public.fiestas_sales to anon, authenticated;
drop policy if exists fiestas_realtime_attendees on public.fiestas_attendees;
drop policy if exists fiestas_realtime_products on public.fiestas_products;
drop policy if exists fiestas_realtime_sales on public.fiestas_sales;
create policy fiestas_realtime_attendees on public.fiestas_attendees for select to anon, authenticated using (true);
create policy fiestas_realtime_products on public.fiestas_products for select to anon, authenticated using (true);
create policy fiestas_realtime_sales on public.fiestas_sales for select to anon, authenticated using (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fiestas_attendees') then
    alter publication supabase_realtime add table public.fiestas_attendees;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fiestas_products') then
    alter publication supabase_realtime add table public.fiestas_products;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fiestas_sales') then
    alter publication supabase_realtime add table public.fiestas_sales;
  end if;
end $$;

commit;
