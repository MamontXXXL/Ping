import { getSupabase, isSupabaseConfigured } from './supabaseClient.js';

const TABLE = 'leaderboard';

/**
 * Загружает топ игроков, отсортированных по победам.
 */
export async function loadLeaderboard(limit = 20) {
  const supabase = getSupabase();
  if (!supabase) return { rows: [], error: 'not_configured' };

  const { data, error } = await supabase
    .from(TABLE)
    .select('nickname, wins, losses')
    .order('wins', { ascending: false })
    .order('losses', { ascending: true })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  return { rows: data ?? [], error: null };
}

/**
 * Записывает результат матча в публичную таблицу лидеров.
 * Реализовано как "прочитать -> посчитать -> записать": для демо-проекта
 * этого достаточно. Для защиты от гонок при высокой нагрузке лучше
 * заменить на Postgres RPC-функцию с атомарным increment (см. README).
 */
export async function recordMatchResult(nickname, didWin) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { data: existing } = await supabase
    .from(TABLE)
    .select('wins, losses')
    .eq('nickname', nickname)
    .maybeSingle();

  const wins = (existing?.wins ?? 0) + (didWin ? 1 : 0);
  const losses = (existing?.losses ?? 0) + (didWin ? 0 : 1);

  await supabase
    .from(TABLE)
    .upsert({ nickname, wins, losses, updated_at: new Date().toISOString() }, { onConflict: 'nickname' });
}

export { isSupabaseConfigured };
