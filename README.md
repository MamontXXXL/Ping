# PONG // NEON

Браузерный неоновый Pong: игра против бота, PvP-мультиплеер в реальном времени и публичная таблица лидеров. Полностью статичный фронтенд (HTML/CSS/vanilla JS) — деплоится на GitHub Pages. Бэкендом служит **Supabase** (бесплатный тариф): Postgres-таблицы + Realtime (WebSocket) для матчмейкинга и синхронизации игры.

## Почему Supabase, а не PeerJS

GitHub Pages хостит только статику, поэтому для реального времени и подбора соперников нужен внешний сервис. Вариантов два: PeerJS (чистый P2P, нужен свой signaling-сервер или публичный broker) или Supabase Realtime (WebSocket-каналы + БД в одном бесплатном проекте). Выбран **Supabase**, потому что:

- очередь матчмейкинга — это просто строка в Postgres-таблице, не нужен отдельный signaling-сервер;
- тот же проект хранит и таблицу лидеров;
- бесплатный тариф не требует своего сервера и карты.

Архитектура синхронизации — **host-authoritative**: один из двух игроков (браузер с меньшим id) считает физику мяча и ~25 раз/сек рассылает состояние второму через Realtime Broadcast; второй игрок отправляет хосту только позицию своей мыши.

## Структура проекта

```
pong-neon/
├── index.html          # разметка: экраны авторизации, меню, игры, лидерборда
├── style.css            # неоновое оформление
├── js/
│   ├── supabaseClient.js # инициализация клиента Supabase (сюда вписать ключи)
│   ├── leaderboard.js    # чтение/запись таблицы лидеров
│   ├── matchmaking.js    # очередь подбора соперника + realtime-канал матча
│   ├── game.js            # физика Pong, рендер на canvas, ИИ бота
│   └── main.js            # экраны, мышь, игровой цикл, склейка всего
└── README.md
```

## 1. Запуск локально

Модули (`type="module"`) не работают через `file://`, нужен любой локальный http-сервер:

```bash
cd pong-neon
python3 -m http.server 8080
# затем открыть http://localhost:8080
```

или, если есть Node.js:

```bash
npx serve pong-neon
```

Без настройки Supabase игра **против бота работает сразу**. Кнопка PvP и таблица лидеров будут отключены/покажут предупреждение, пока не подключите бэкенд (шаг 2).

## 2. Настройка Supabase (бесплатно)

1. Зарегистрируйтесь на [supabase.com](https://supabase.com) и создайте новый проект (Free tier).
2. В **Project Settings → API** скопируйте `Project URL` и `anon public` ключ.
3. Откройте `js/supabaseClient.js` и вставьте их:

```js
export const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...'; // anon public key
```

4. В **SQL Editor** выполните схему ниже — она создаёт таблицу лидеров и очередь матчмейкинга, включает Row Level Security с публичным доступом (для демо-проекта; в продакшене стоит ограничить политики).

```sql
-- Таблица лидеров
create table public.leaderboard (
  nickname   text primary key,
  wins       integer not null default 0,
  losses     integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.leaderboard enable row level security;

create policy "leaderboard_public_read"   on public.leaderboard for select using (true);
create policy "leaderboard_public_insert" on public.leaderboard for insert with check (true);
create policy "leaderboard_public_update" on public.leaderboard for update using (true);

-- Очередь матчмейкинга
create table public.matchmaking_queue (
  id         text primary key,
  nickname   text not null,
  created_at timestamptz not null default now()
);

alter table public.matchmaking_queue enable row level security;

create policy "queue_public_all" on public.matchmaking_queue
  for all using (true) with check (true);
```

5. Включите Realtime для обеих таблиц: **Database → Replication** → включите `leaderboard` и `matchmaking_queue` (для очереди важно включить репликацию `matchmaking_queue`, чтобы работали `postgres_changes`-подписки). Broadcast-каналы для самого матча (`game-<roomId>`) в проверке репликации не нуждаются — Realtime Broadcast включён по умолчанию для любого проекта.
6. Сохраните файл — готово, PvP и лидерборд заработают.

### Про надёжность записи в лидерборд

Текущая реализация в `leaderboard.js` делает "прочитать → посчитать → записать" без транзакции — для учебного/демо-проекта этого достаточно, но при одновременных запросах возможна гонка (два быстрых матча подряд могут перезаписать друг друга). Для продакшена замените `recordMatchResult` на вызов Postgres RPC-функции с атомарным инкрементом, например:

```sql
create or replace function increment_score(p_nickname text, p_win boolean)
returns void language plpgsql as $$
begin
  insert into public.leaderboard (nickname, wins, losses)
  values (p_nickname, case when p_win then 1 else 0 end, case when p_win then 0 else 1 end)
  on conflict (nickname) do update
    set wins = leaderboard.wins + case when p_win then 1 else 0 end,
        losses = leaderboard.losses + case when p_win then 0 else 1 end,
        updated_at = now();
end;
$$;
```

и вызывать её через `supabase.rpc('increment_score', { p_nickname, p_win })`.

## 3. Деплой на GitHub Pages

1. Создайте новый репозиторий на GitHub и загрузите в него содержимое папки `pong-neon` (файлы должны лежать в корне репозитория, либо в корне ветки `gh-pages`):

```bash
cd pong-neon
git init
git add .
git commit -m "PONG // NEON"
git branch -M main
git remote add origin https://github.com/<ваш-логин>/<репозиторий>.git
git push -u origin main
```

2. В репозитории на GitHub откройте **Settings → Pages**.
3. В **Source** выберите ветку `main` и папку `/ (root)`.
4. Сохраните — через минуту сайт будет доступен по адресу вида `https://<ваш-логин>.github.io/<репозиторий>/`.
5. Не забудьте, что ключи в `js/supabaseClient.js` — это `anon public` ключ, его безопасно публиковать в статическом фронтенде (доступ к данным регулируется политиками RLS в Supabase, не секретностью ключа).

## Как работает подбор соперника (кратко)

1. Игрок нажимает «Мультиплеер» → в таблицу `matchmaking_queue` добавляется строка с его id и ником.
2. Клиент подписывается на изменения этой таблицы через Realtime `postgres_changes`.
3. Как только в очереди оказывается ≥2 игроков, оба клиента детерминированно считают одинаковый `roomId` (отсортированная пара id) — договариваться через сервер не нужно.
4. Игрок с меньшим id становится хостом: считает физику мяча и ~25 раз/сек шлёт состояние через Realtime Broadcast-канал `game-<roomId>`. Второй игрок шлёт только позицию своей ракетки.
5. Обе строки удаляются из очереди, чтобы не заматчить кого-то ещё раз с уже занятым игроком.

## Известные ограничения демо-версии

- Логин/пароль не проверяются на сервере — это визуальная идентификация игрока, а не полноценная аутентификация (для этого потребуется Supabase Auth и отдельная форма входа с паролем).
- При потере соединения во время PvP-матча текущая версия не делает автоматический reconnect/resync — игроку нужно вернуться в меню и найти новый матч.
- Запись в лидерборд не атомарна (см. раздел выше) — при желании доработайте через RPC.
