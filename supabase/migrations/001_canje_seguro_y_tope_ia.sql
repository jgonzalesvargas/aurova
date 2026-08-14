-- =========================================================================
-- 001 · Canje de códigos a prueba de consola + tope de IA en el servidor
--
-- PROBLEMA 1 — Premium gratis para cualquiera que sepa abrir la consola.
--   El 20 jul se movió la validación de Premium al servidor (entitlement.ts),
--   pero las ENTRADAS de esa validación las escribía el propio cliente:
--     · promo_codes  SELECT = true (authenticated) → cualquiera lista TODOS
--                                                    los códigos, incluido el
--                                                    VIP "gratis para siempre"
--     · redemptions  INSERT = auth.uid() = user_id → cualquiera se inserta un
--                                                    canje de ese código
--   Dos llamadas desde la consola del navegador y el usuario tiene Premium
--   permanente sin pagar. Lo mismo con referral_codes + referrals (1 mes).
--   El gate era server-side, pero los datos que leía eran del atacante.
--
-- PROBLEMA 2 — Códigos sin tope de usos.
--   Un código como FAMILIA2026 se comparte en un grupo de WhatsApp y lo canjea
--   quien sea, sin límite. No había forma de acotarlo.
--
-- PROBLEMA 3 — El asistente IA no tiene tope diario real.
--   ai-chat verifica Premium pero no cuántas veces. Quien tenga Premium (o un
--   código VIP) puede llamarlo en bucle y quemar créditos de Anthropic. El tope
--   de 30/día vive en index.html, o sea en la máquina del usuario.
--
-- SOLUCIÓN — el canje deja de ser un INSERT del cliente y pasa a ser una
--   función `security definer`: el servidor valida y escribe; el cliente solo
--   manda el texto del código y recibe un veredicto.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1 · Tope de usos por código
-- -------------------------------------------------------------------------
alter table public.promo_codes
  add column if not exists max_uses integer;

comment on column public.promo_codes.max_uses is
  'Máximo de canjes permitidos. NULL = ilimitado. Se cuenta contra redemptions.';

-- -------------------------------------------------------------------------
-- 2 · Cerrar la lectura de códigos
--    El usuario nunca necesita LISTAR códigos: escribe uno y el servidor le
--    dice si sirve. Dejarlo abierto es publicar la lista de llaves.
-- -------------------------------------------------------------------------
drop policy if exists promo_read on public.promo_codes;
create policy promo_read on public.promo_codes for select to authenticated using (
  (auth.jwt() ->> 'email') = 'jesusgonzales0703@gmail.com'
);

-- El usuario sí necesita ver SU código de referido (para compartirlo), pero no
-- los de los demás — con la lista completa se regalaba un mes a sí mismo.
drop policy if exists refcode_read on public.referral_codes;
create policy refcode_read on public.referral_codes for select to authenticated using (
  owner_id = auth.uid()
  or (auth.jwt() ->> 'email') = 'jesusgonzales0703@gmail.com'
);

-- -------------------------------------------------------------------------
-- 3 · Quitarle al cliente la escritura de canjes
--    Estas dos policies eran el agujero: permitían al usuario declarar por su
--    cuenta que canjeó algo. A partir de aquí solo escribe la función de abajo.
-- -------------------------------------------------------------------------
drop policy if exists red_ins on public.redemptions;
drop policy if exists ref_ins on public.referrals;

-- -------------------------------------------------------------------------
-- 4 · El canje, en el servidor
--
--    security definer = corre con los permisos del dueño de la función, así
--    que puede leer promo_codes y escribir redemptions aunque el usuario ya no
--    pueda. search_path fijo para que nadie pueda secuestrarla con una tabla
--    homónima en otro esquema.
-- -------------------------------------------------------------------------
create or replace function public.canjear_codigo(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text := upper(trim(coalesce(p_code, '')));
  v_promo public.promo_codes%rowtype;
  v_usos  integer;
  v_owner uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'msg', 'no_auth');
  end if;
  if v_code = '' then
    return jsonb_build_object('ok', false, 'msg', 'vacio');
  end if;

  -- ---------- Código promocional ----------
  select * into v_promo from public.promo_codes
   where upper(code) = v_code and active is true;

  if found then
    if v_promo.expires_at is not null and v_promo.expires_at <= now() then
      return jsonb_build_object('ok', false, 'msg', 'vencido');
    end if;

    -- Ya lo usó: no se apila ni consume otro cupo.
    if exists (select 1 from public.redemptions
                where user_id = v_uid and upper(code) = v_code) then
      return jsonb_build_object('ok', false, 'msg', 'ya_usado');
    end if;

    if v_promo.max_uses is not null then
      select count(*) into v_usos from public.redemptions where upper(code) = v_code;
      if v_usos >= v_promo.max_uses then
        return jsonb_build_object('ok', false, 'msg', 'agotado');
      end if;
    end if;

    insert into public.redemptions (user_id, code, kind)
    values (v_uid, v_promo.code, v_promo.kind);

    return jsonb_build_object(
      'ok', true, 'tipo', 'promo',
      'kind', v_promo.kind, 'months', v_promo.months, 'percent', v_promo.percent
    );
  end if;

  -- ---------- Código de referido ----------
  select owner_id into v_owner from public.referral_codes where upper(code) = v_code;

  if v_owner is not null then
    if v_owner = v_uid then
      return jsonb_build_object('ok', false, 'msg', 'propio');
    end if;
    if exists (select 1 from public.referrals where referee_id = v_uid) then
      return jsonb_build_object('ok', false, 'msg', 'ya_referido');
    end if;

    insert into public.referrals (referrer_code, referee_id)
    values (v_code, v_uid);

    return jsonb_build_object('ok', true, 'tipo', 'referido', 'months', 1);
  end if;

  return jsonb_build_object('ok', false, 'msg', 'invalido');
end;
$$;

revoke all on function public.canjear_codigo(text) from public;
grant execute on function public.canjear_codigo(text) to authenticated;

-- -------------------------------------------------------------------------
-- 5 · Tope diario del asistente IA, contado en el servidor
--
--    La escribe únicamente ai-chat con service role. Sin policy de INSERT ni
--    UPDATE: el cliente puede ver su consumo pero nunca bajarlo.
-- -------------------------------------------------------------------------
create table if not exists public.ia_uso (
  user_id uuid not null references auth.users(id) on delete cascade,
  dia     date not null default (now() at time zone 'utc')::date,
  usos    integer not null default 0,
  primary key (user_id, dia)
);

comment on table public.ia_uso is
  'Consumo diario del asistente IA. La escribe la Edge Function ai-chat con service role.';

alter table public.ia_uso enable row level security;

drop policy if exists ia_uso_sel on public.ia_uso;
create policy ia_uso_sel on public.ia_uso for select to authenticated using (
  user_id = auth.uid()
);

-- Suma uno y devuelve el total del día. Atómica: dos pestañas a la vez no
-- pueden colarse por la rendija entre leer y escribir.
--
-- Recibe el usuario por parámetro en vez de usar auth.uid(): quien la llama es
-- ai-chat con service role, donde auth.uid() es NULL. Por eso mismo el permiso
-- de ejecución es SOLO para service_role — si `authenticated` pudiera llamarla,
-- un usuario podría inflarle el contador a otro pasando su id.
create or replace function public.ia_consumir(p_user uuid, p_max integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoy  date := (now() at time zone 'utc')::date;
  v_usos integer;
begin
  if p_user is null then
    return jsonb_build_object('ok', false, 'msg', 'no_auth');
  end if;

  insert into public.ia_uso (user_id, dia, usos)
  values (p_user, v_hoy, 1)
  on conflict (user_id, dia) do update set usos = public.ia_uso.usos + 1
  returning usos into v_usos;

  if v_usos > p_max then
    return jsonb_build_object('ok', false, 'msg', 'tope', 'usos', v_usos, 'max', p_max);
  end if;
  return jsonb_build_object('ok', true, 'usos', v_usos, 'max', p_max);
end;
$$;

revoke all on function public.ia_consumir(uuid, integer) from public;
revoke all on function public.ia_consumir(uuid, integer) from authenticated;
grant execute on function public.ia_consumir(uuid, integer) to service_role;

-- -------------------------------------------------------------------------
-- 6 · Revocar EXECUTE por ROL, no solo de PUBLIC
--
--    Supabase concede EXECUTE a `anon` y `authenticated` por defecto en toda
--    función nueva del esquema public. `revoke ... from public` NO quita esas
--    concesiones (son por rol, no del pseudo-rol PUBLIC) — hay que nombrarlas.
--    Sin esto, ia_consumir queda llamable sin sesión y, como recibe el usuario
--    por parámetro, cualquiera podría agotarle la cuota diaria de IA a otro.
-- -------------------------------------------------------------------------
revoke execute on function public.ia_consumir(uuid, integer) from anon;
revoke execute on function public.ia_consumir(uuid, integer) from authenticated;
revoke execute on function public.canjear_codigo(text) from anon;
