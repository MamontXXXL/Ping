// ============================================================
//  Supabase — единственный бэкенд проекта.
//  Бесплатный тариф Supabase даёт:
//    - Postgres БД (таблица лидеров, очередь матчмейкинга)
//    - Realtime (Broadcast/Postgres Changes) для PvP по WebSocket
//  Это удобнее, чем чистый PeerJS, потому что не нужен отдельный
//  сервер для подбора соперников — очередь хранится в той же БД.
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// --- ЗАМЕНИТЕ на данные своего проекта Supabase (см. README.md) ---
export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-PUBLIC-ANON-KEY';
// --------------------------------------------------------------

let client = null;
let configured = SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR-PROJECT-REF');

export function isSupabaseConfigured() {
  return configured;
}

export function getSupabase() {
  if (!configured) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 20 } }
    });
  }
  return client;
}
