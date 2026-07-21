import { getSupabase, isSupabaseConfigured } from './supabaseClient.js';

const QUEUE_TABLE = 'matchmaking_queue';

/**
 * ====================== КАК РАБОТАЕТ ПОДБОР СОПЕРНИКА ======================
 * 1. Игрок нажимает "PvP" -> в таблицу `matchmaking_queue` добавляется строка
 *    {id, nickname, created_at}.
 * 2. Клиент подписывается на Postgres Changes (Realtime) этой таблицы —
 *    любое изменение очереди у ЛЮБОГО игрока триггерит проверку у всех.
 * 3. Проверка "checkQueue" читает 2 самые старые записи в очереди.
 *    Если среди них есть я — матч найден.
 * 4. Оба клиента детерминированно считают одинаковый roomId
 *    (отсортированная пара id), поэтому им не нужно "договариваться" —
 *    они оба просто подключаются к одному Realtime Broadcast-каналу.
 * 5. Внутри комнаты один из игроков (тот, чей id меньше при сравнении строк)
 *    становится "хостом" — именно его браузер считает физику мяча и шлёт
 *    состояние (позиции, счёт) второму игроку 30+ раз в секунду через
 *    Broadcast-событие "state". Второй игрок только шлёт свою позицию
 *    ракетки событием "input". Это простая модель host-authoritative,
 *    которая не требует отдельного игрового сервера.
 * ============================================================================
 */

function getMyId() {
  let id = sessionStorage.getItem('pong_player_id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('pong_player_id', id);
  }
  return id;
}

export const myId = getMyId();

let queueChannel = null;
let matchResolved = false;

async function checkQueue(nickname, onMatched) {
  const supabase = getSupabase();
  if (!supabase || matchResolved) return;

  const { data, error } = await supabase
    .from(QUEUE_TABLE)
    .select('id, nickname, created_at')
    .order('created_at', { ascending: true })
    .limit(2);

  if (error || !data || data.length < 2) return;

  const [a, b] = data;
  const iAmInvolved = a.id === myId || b.id === myId;
  if (!iAmInvolved) return;

  matchResolved = true;

  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  const roomId = `${first.id}__${second.id}`;
  const isHost = myId === first.id;
  const opponent = myId === a.id ? b : a;

  // Лучшее усилие: убрать обе записи из очереди, чтобы других не сматчило с нами повторно.
  await supabase.from(QUEUE_TABLE).delete().in('id', [a.id, b.id]);

  await leaveQueueChannel();
  onMatched({ roomId, isHost, opponentId: opponent.id, opponentNickname: opponent.nickname });
}

/**
 * Встаёт в очередь на поиск соперника и вызывает onMatched({roomId, isHost, opponentNickname})
 * когда пара найдена.
 */
export async function findMatch(nickname, onMatched, onError) {
  const supabase = getSupabase();
  if (!supabase) {
    onError?.('Supabase не настроен. Укажите SUPABASE_URL и SUPABASE_ANON_KEY в js/supabaseClient.js');
    return;
  }
  matchResolved = false;

  const { error } = await supabase.from(QUEUE_TABLE).insert({ id: myId, nickname });
  if (error) {
    onError?.(error.message);
    return;
  }

  queueChannel = supabase
    .channel('matchmaking-watch')
    .on('postgres_changes', { event: '*', schema: 'public', table: QUEUE_TABLE }, () => {
      checkQueue(nickname, onMatched);
    })
    .subscribe();

  // Проверяем сразу — вдруг соперник уже ждал в очереди.
  checkQueue(nickname, onMatched);
}

async function leaveQueueChannel() {
  if (queueChannel) {
    const supabase = getSupabase();
    await supabase.removeChannel(queueChannel);
    queueChannel = null;
  }
}

/**
 * Отмена поиска: убираем себя из очереди и отписываемся.
 */
export async function cancelSearch() {
  matchResolved = true;
  const supabase = getSupabase();
  if (supabase) {
    await supabase.from(QUEUE_TABLE).delete().eq('id', myId);
  }
  await leaveQueueChannel();
}

/**
 * Открывает realtime Broadcast-канал конкретного матча.
 * handlers: { onState(state), onInput(input), onEnd(result), onReady() }
 * Возвращает { sendState, sendInput, sendEnd, leave }
 */
export function createGameChannel(roomId, handlers) {
  const supabase = getSupabase();
  const channel = supabase.channel(`game-${roomId}`, {
    config: { broadcast: { self: false, ack: false } }
  });

  channel
    .on('broadcast', { event: 'state' }, (msg) => handlers.onState?.(msg.payload))
    .on('broadcast', { event: 'input' }, (msg) => handlers.onInput?.(msg.payload))
    .on('broadcast', { event: 'end' }, (msg) => handlers.onEnd?.(msg.payload))
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') handlers.onReady?.();
    });

  return {
    sendState: (state) => channel.send({ type: 'broadcast', event: 'state', payload: state }),
    sendInput: (input) => channel.send({ type: 'broadcast', event: 'input', payload: input }),
    sendEnd: (result) => channel.send({ type: 'broadcast', event: 'end', payload: result }),
    leave: () => supabase.removeChannel(channel)
  };
}

export { isSupabaseConfigured };
