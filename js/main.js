import { PongGame, FIELD_W, FIELD_H } from './game.js';
import { loadLeaderboard, recordMatchResult, isSupabaseConfigured } from './leaderboard.js';
import { findMatch, cancelSearch, createGameChannel, myId } from './matchmaking.js';

// ---------- DOM ----------
const screens = {
  auth: document.getElementById('screen-auth'),
  menu: document.getElementById('screen-menu'),
  game: document.getElementById('screen-game'),
  leaderboard: document.getElementById('screen-leaderboard')
};

const authForm = document.getElementById('auth-form');
const inputNickname = document.getElementById('input-nickname');
const inputLogin = document.getElementById('input-login');
const authError = document.getElementById('auth-error');

const menuPlayerName = document.getElementById('menu-player-name');
const connectionStatus = document.getElementById('connection-status');
const btnPlayBot = document.getElementById('btn-play-bot');
const btnPlayPvp = document.getElementById('btn-play-pvp');
const btnLeaderboard = document.getElementById('btn-leaderboard');
const btnLogout = document.getElementById('btn-logout');
const btnLeaderboardBack = document.getElementById('btn-leaderboard-back');

const canvas = document.getElementById('game-canvas');
const cabinet = document.querySelector('.cabinet');
const hintEl = document.getElementById('game-hint');
const hudNameLeft = document.getElementById('hud-name-left');
const hudNameRight = document.getElementById('hud-name-right');
const hudScoreLeft = document.getElementById('hud-score-left');
const hudScoreRight = document.getElementById('hud-score-right');
const hudMode = document.getElementById('hud-mode');

const overlayWaiting = document.getElementById('overlay-waiting');
const btnCancelSearch = document.getElementById('btn-cancel-search');
const overlayResult = document.getElementById('overlay-result');
const overlayResultText = document.getElementById('overlay-result-text');
const btnRematch = document.getElementById('btn-rematch');
const btnToMenu = document.getElementById('btn-to-menu');
const overlayCountdown = document.getElementById('overlay-countdown');
const overlayCountdownText = document.getElementById('overlay-countdown-text');
const overlayLock = document.getElementById('overlay-lock');

const leaderboardBody = document.getElementById('leaderboard-body');

// ---------- Состояние приложения ----------
let player = null; // { nickname, login }
let game = null;
let animationHandle = null;
let lastTs = 0;
let netChannel = null;
let currentMatch = null; // { roomId, isHost, opponentNickname }
const NET_SEND_INTERVAL = 1000 / 25; // 25 сообщений/сек
let lastNetSend = 0;

// ---------- Pointer Lock (захват курсора) ----------
const DEFAULT_HINT = 'Кликни по полю, чтобы захватить курсор — двигай мышью вверх/вниз. E — отпустить курсор';
const LOCKED_HINT = 'Курсор захвачен — двигай мышью вверх/вниз. E — отпустить курсор';
let capturedY = FIELD_H / 2; // виртуальная Y-позиция ракетки при захваченном курсоре
let awaitingFirstLock = false; // ждём первого клика/захвата перед стартом раунда

function isPointerLocked() {
  return document.pointerLockElement === canvas;
}

if (hintEl) hintEl.textContent = DEFAULT_HINT;

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove('screen--active'));
  screens[name].classList.add('screen--active');
}

// ---------- Авторизация ----------
const STORAGE_KEY = 'pong_neon_player';

function tryRestoreSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    player = JSON.parse(raw);
    enterMenu();
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = inputNickname.value.trim();
  const login = inputLogin.value.trim();

  if (nickname.length < 2) {
    authError.textContent = 'Никнейм должен быть от 2 символов';
    return;
  }
  if (login.length < 3) {
    authError.textContent = 'Логин должен быть от 3 символов';
    return;
  }

  authError.textContent = '';
  player = { nickname, login };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(player));
  enterMenu();
});

btnLogout.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  player = null;
  showScreen('auth');
});

function enterMenu() {
  menuPlayerName.textContent = player.nickname;
  connectionStatus.textContent = isSupabaseConfigured()
    ? 'Подключено к серверу ✔'
    : '⚠ Supabase не настроен — PvP и лидерборд недоступны (см. README.md)';
  btnPlayPvp.disabled = !isSupabaseConfigured();
  showScreen('menu');
}

// ---------- Игра против бота ----------
btnPlayBot.addEventListener('click', () => {
  startGame({ mode: 'bot' });
});

// ---------- PvP матчмейкинг ----------
btnPlayPvp.addEventListener('click', () => {
  showScreen('game');
  overlayWaiting.classList.remove('hidden');
  overlayResult.classList.add('hidden');
  hudMode.textContent = 'PVP // ПОИСК';
  hudNameLeft.textContent = player.nickname;
  hudNameRight.textContent = '???';
  hudScoreLeft.textContent = '0';
  hudScoreRight.textContent = '0';

  findMatch(
    player.nickname,
    (match) => {
      overlayWaiting.classList.add('hidden');
      currentMatch = match;
      beginPvpMatch(match);
    },
    (errMsg) => {
      overlayWaiting.classList.add('hidden');
      alert('Не удалось начать поиск: ' + errMsg);
      showScreen('menu');
    }
  );
});

btnCancelSearch.addEventListener('click', async () => {
  await cancelSearch();
  overlayWaiting.classList.add('hidden');
  showScreen('menu');
});

function beginPvpMatch(match) {
  hudMode.textContent = `PVP // ${match.isHost ? 'ХОСТ' : 'ГОСТЬ'}`;
  hudNameLeft.textContent = match.isHost ? player.nickname : match.opponentNickname;
  hudNameRight.textContent = match.isHost ? match.opponentNickname : player.nickname;

  startGame({ mode: match.isHost ? 'pvp-host' : 'pvp-guest' });

  netChannel = createGameChannel(match.roomId, {
    onState: (state) => {
      if (game.mode === 'pvp-guest') game.applyRemoteState(state);
    },
    onInput: (input) => {
      if (game.mode === 'pvp-host') game.setRemoteInputY(input.y);
    },
    onEnd: () => {},
    onReady: () => {}
  });
}

// ---------- Игровой цикл ----------
function startGame({ mode }) {
  showScreen('game');
  overlayResult.classList.add('hidden');
  overlayWaiting.classList.add('hidden');
  overlayCountdown.classList.add('hidden');

  if (!game) {
    game = new PongGame(canvas);
  } else {
    game.restart();
  }
  game.setMode(mode);
  capturedY = FIELD_H / 2;
  game.setLocalMouseY(capturedY);

  if (mode === 'bot') {
    hudMode.textContent = 'VS BOT';
    hudNameLeft.textContent = player.nickname;
    hudNameRight.textContent = 'БОТ';
  }

  game.onScoreChange = (l, r) => {
    hudScoreLeft.textContent = l;
    hudScoreRight.textContent = r;
  };

  game.onGameEnd = (winnerSide) => {
    onMatchEnd(winnerSide);
  };

  // Раунд стартует только после захвата курсора игроком (клик по полю).
  if (isPointerLocked()) {
    // Курсор уже захвачен с прошлого раунда (например, реванш) — стартуем сразу.
    overlayLock.classList.add('hidden');
    beginRound();
  } else {
    awaitingFirstLock = true;
    overlayLock.classList.remove('hidden');
  }
}

function beginRound() {
  runCountdown(3, () => {
    lastTs = performance.now();
    if (animationHandle) cancelAnimationFrame(animationHandle);
    loop();
  });
}

function runCountdown(from, done) {
  overlayCountdown.classList.remove('hidden');
  let n = from;
  overlayCountdownText.textContent = n;
  const iv = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(iv);
      overlayCountdown.classList.add('hidden');
      done();
    } else {
      overlayCountdownText.textContent = n;
    }
  }, 700);
}

function loop(ts) {
  animationHandle = requestAnimationFrame(loop);
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.033, ((ts ?? performance.now()) - lastTs) / 1000);
  lastTs = ts ?? performance.now();

  if (game.mode === 'bot' || game.mode === 'pvp-host') {
    game.update(dt);
  }

  // Сеть: троттлим отправку до NET_SEND_INTERVAL
  const now = performance.now();
  if (netChannel && now - lastNetSend > NET_SEND_INTERVAL) {
    lastNetSend = now;
    if (game.mode === 'pvp-host') {
      netChannel.sendState(game.getStateSnapshot());
    } else if (game.mode === 'pvp-guest') {
      netChannel.sendInput({ y: game.localTargetY });
    }
  }

  game.render();
}

// ---------- Захват курсора (Pointer Lock API) ----------
// Клик по игровому полю захватывает курсор — он становится невидимым
// и не покидает окно; движение мыши после этого читается по movementY.
cabinet.addEventListener('click', () => {
  if (!isPointerLocked() && canvas.requestPointerLock) {
    canvas.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  if (isPointerLocked()) {
    overlayLock.classList.add('hidden');
    if (hintEl) hintEl.textContent = LOCKED_HINT;
    if (awaitingFirstLock) {
      awaitingFirstLock = false;
      beginRound();
    }
  } else {
    if (hintEl) hintEl.textContent = DEFAULT_HINT;
  }
});

// Клавиша E — отпустить захваченный курсор.
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'e' && isPointerLocked()) {
    document.exitPointerLock();
  }
});

// Мышь -> ракетка. Пока курсор захвачен — двигаем по относительному
// смещению (movementY); иначе — по абсолютной позиции над canvas
// (запасной вариант для устройств без Pointer Lock).
canvas.addEventListener('mousemove', (e) => {
  if (!game) return;
  const rect = canvas.getBoundingClientRect();
  const scaleY = FIELD_H / rect.height;

  if (isPointerLocked()) {
    capturedY += e.movementY * scaleY;
    capturedY = Math.max(0, Math.min(FIELD_H, capturedY));
    game.setLocalMouseY(capturedY);
  } else {
    const y = (e.clientY - rect.top) * scaleY;
    capturedY = y; // держим в синхроне, чтобы при захвате не было "прыжка"
    game.setLocalMouseY(y);
  }
});

// ---------- Конец матча ----------
function onMatchEnd(winnerSide) {
  if (animationHandle) cancelAnimationFrame(animationHandle);

  let didWin;
  if (game.mode === 'pvp-guest') {
    didWin = winnerSide === 'right';
  } else {
    // 'bot' и 'pvp-host' -> мой игрок всегда слева
    didWin = winnerSide === 'left';
  }

  overlayResultText.textContent = didWin ? 'ПОБЕДА 🏆' : 'ПОРАЖЕНИЕ';
  overlayResultText.style.color = didWin ? '#2fe8ff' : '#ff2fb0';
  overlayResultText.style.textShadow = didWin
    ? '0 0 14px #2fe8ff'
    : '0 0 14px #ff2fb0';
  overlayResult.classList.remove('hidden');

  if (isSupabaseConfigured()) {
    // Для PvP и хост, и гость независимо друг от друга фиксируют свой
    // собственный итог матча — на сервере это просто два разных upsert'а.
    recordMatchResult(player.nickname, didWin);
  }

  // Гостю в PvP кнопка "Играть снова" недоступна — решение принимает хост.
  btnRematch.style.display = game.mode === 'pvp-guest' ? 'none' : 'inline-flex';
}

btnRematch.addEventListener('click', () => {
  const mode = game.mode;
  startGame({ mode });
});

btnToMenu.addEventListener('click', () => {
  cleanupMatch();
  showScreen('menu');
});

function cleanupMatch() {
  if (netChannel) {
    netChannel.leave();
    netChannel = null;
  }
  currentMatch = null;
  if (animationHandle) cancelAnimationFrame(animationHandle);
}

// ---------- Таблица лидеров ----------
btnLeaderboard.addEventListener('click', async () => {
  showScreen('leaderboard');
  await renderLeaderboard();
});
btnLeaderboardBack.addEventListener('click', () => showScreen('menu'));

async function renderLeaderboard() {
  leaderboardBody.innerHTML = '<tr><td colspan="4" class="muted">Загрузка…</td></tr>';
  const { rows, error } = await loadLeaderboard();

  if (error === 'not_configured') {
    leaderboardBody.innerHTML = '<tr><td colspan="4" class="muted">Supabase не настроен — см. README.md</td></tr>';
    return;
  }
  if (error) {
    leaderboardBody.innerHTML = `<tr><td colspan="4" class="muted">Ошибка: ${error}</td></tr>`;
    return;
  }
  if (rows.length === 0) {
    leaderboardBody.innerHTML = '<tr><td colspan="4" class="muted">Пока нет результатов — сыграйте первым!</td></tr>';
    return;
  }

  leaderboardBody.innerHTML = rows
    .map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.nickname)}</td><td>${r.wins}</td><td>${r.losses}</td></tr>`)
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Старт ----------
tryRestoreSession();
