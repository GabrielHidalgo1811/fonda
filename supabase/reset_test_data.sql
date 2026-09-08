-- Borra solamente los datos operativos de prueba.
-- Conserva las tablas, funciones, permisos y catálogo de productos.
begin;

truncate table
  public.fiestas_drink_movements,
  public.fiestas_operations,
  public.fiestas_sales,
  public.fiestas_attendees
restart identity;

commit;
