// ============================================================
//  Игровой движок Pong. Работает в трёх режимах:
//   - 'bot'        : локальная физика + ИИ противника
//   - 'pvp-host'    : локальная физика (авторитетная), состояние
//                      рассылается второму игроку
//   - 'pvp-guest'   : физику не считает, отрисовывает состояние,
//                      полученное от хоста; своя ракетка двигается
//                      локально мгновенно (без задержки сети)
// ============================================================

export const FIELD_W = 900;
export const FIELD_H = 540;
const PADDLE_W = 14;
const PADDLE_H = 100;
const BALL_R = 8;
const WIN_SCORE = 7;
const BASE_BALL_SPEED = 380; // px/sec
const MAX_BALL_SPEED = 820;

export class PongGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'bot'; // 'bot' | 'pvp-host' | 'pvp-guest'
    this.botDifficulty = 0.85; // 0..1, влияет на скорость реакции ИИ

    this.leftY = FIELD_H / 2;
    this.rightY = FIELD_H / 2;
    this.remoteTargetY = FIELD_H / 2; // для host: последняя присланная позиция гостя
    this.localTargetY = FIELD_H / 2;  // мышь текущего игрока

    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.winner = null; // 'left' | 'right' | null

    this.onScoreChange = null;
    this.onGameEnd = null; // (winnerSide) => void

    this._resetBall(Math.random() < 0.5 ? 'left' : 'right');
  }

  setMode(mode) {
    this.mode = mode;
  }

  /** Локальный игрок двигает мышью — обновляем целевую Y своей ракетки. */
  setLocalMouseY(y) {
    this.localTargetY = Math.min(FIELD_H - PADDLE_H / 2, Math.max(PADDLE_H / 2, y));
    if (this.mode === 'pvp-guest') {
      this.rightY = this.localTargetY;
    }
  }

  /** Хост получил позицию ракетки гостя по сети. */
  setRemoteInputY(y) {
    this.remoteTargetY = y;
  }

  /** Гость получил снапшот состояния от хоста. */
  applyRemoteState(state) {
    this.leftY = state.leftY;
    this.ballX = state.ballX;
    this.ballY = state.ballY;
    if (this.scoreLeft !== state.scoreLeft || this.scoreRight !== state.scoreRight) {
      this.scoreLeft = state.scoreLeft;
      this.scoreRight = state.scoreRight;
      this.onScoreChange?.(this.scoreLeft, this.scoreRight);
    }
    const wasWinner = this.winner;
    this.winner = state.winner ?? null;
    if (this.winner && !wasWinner) {
      this.onGameEnd?.(this.winner);
    }
  }

  /** Снапшот для рассылки гостю (вызывается хостом). */
  getStateSnapshot() {
    return {
      leftY: this.leftY,
      ballX: this.ballX,
      ballY: this.ballY,
      scoreLeft: this.scoreLeft,
      scoreRight: this.scoreRight,
      winner: this.winner
    };
  }

  _resetBall(servingSide) {
    this.ballX = FIELD_W / 2;
    this.ballY = FIELD_H / 2;
    const angle = (Math.random() * 0.6 - 0.3); // небольшой случайный угол
    const dir = servingSide === 'left' ? 1 : -1;
    this.ballVX = Math.cos(angle) * BASE_BALL_SPEED * dir;
    this.ballVY = Math.sin(angle) * BASE_BALL_SPEED;
  }

  restart() {
    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.winner = null;
    this.leftY = FIELD_H / 2;
    this.rightY = FIELD_H / 2;
    this._resetBall(Math.random() < 0.5 ? 'left' : 'right');
  }

  /** Основной шаг физики. Вызывать только в режимах 'bot' и 'pvp-host'. */
  update(dt) {
    if (this.winner) return;

    // Своя ракетка — по мыши.
    if (this.mode === 'bot' || this.mode === 'pvp-host') {
      this.leftY = this.localTargetY;
    }

    if (this.mode === 'bot') {
      this._updateBot(dt);
    } else if (this.mode === 'pvp-host') {
      // Плавно подтягиваем ракетку гостя к последней присланной позиции,
      // чтобы движение не было "телепортирующимся" при редких пакетах.
      const smoothing = Math.min(1, dt * 14);
      this.rightY += (this.remoteTargetY - this.rightY) * smoothing;
    }

    // Движение мяча
    this.ballX += this.ballVX * dt;
    this.ballY += this.ballVY * dt;

    // Отскок от верхней/нижней стены
    if (this.ballY - BALL_R < 0) {
      this.ballY = BALL_R;
      this.ballVY *= -1;
    } else if (this.ballY + BALL_R > FIELD_H) {
      this.ballY = FIELD_H - BALL_R;
      this.ballVY *= -1;
    }

    // Столкновение с левой (синей) ракеткой
    if (
      this.ballVX < 0 &&
      this.ballX - BALL_R <= PADDLE_W + 20 &&
      this.ballX - BALL_R >= 10 &&
      this.ballY >= this.leftY - PADDLE_H / 2 - 4 &&
      this.ballY <= this.leftY + PADDLE_H / 2 + 4
    ) {
      this._bounceOffPaddle(this.leftY, 1);
    }

    // Столкновение с правой (розовой) ракеткой
    if (
      this.ballVX > 0 &&
      this.ballX + BALL_R >= FIELD_W - PADDLE_W - 20 &&
      this.ballX + BALL_R <= FIELD_W - 10 &&
      this.ballY >= this.rightY - PADDLE_H / 2 - 4 &&
      this.ballY <= this.rightY + PADDLE_H / 2 + 4
    ) {
      this._bounceOffPaddle(this.rightY, -1);
    }

    // Гол
    if (this.ballX < -BALL_R * 2) {
      this._score('right');
    } else if (this.ballX > FIELD_W + BALL_R * 2) {
      this._score('left');
    }
  }

  _bounceOffPaddle(paddleY, newDirSign) {
    const offset = (this.ballY - paddleY) / (PADDLE_H / 2); // -1..1
    const speed = Math.min(MAX_BALL_SPEED, Math.hypot(this.ballVX, this.ballVY) * 1.06);
    const angle = offset * (Math.PI / 3.2); // максимум ~56°
    this.ballVX = Math.cos(angle) * speed * newDirSign;
    this.ballVY = Math.sin(angle) * speed;
  }

  _score(side) {
    if (side === 'left') this.scoreLeft++; else this.scoreRight++;
    this.onScoreChange?.(this.scoreLeft, this.scoreRight);

    if (this.scoreLeft >= WIN_SCORE || this.scoreRight >= WIN_SCORE) {
      this.winner = this.scoreLeft > this.scoreRight ? 'left' : 'right';
      this.onGameEnd?.(this.winner);
      return;
    }
    this._resetBall(side === 'left' ? 'right' : 'left');
  }

  _updateBot(dt) {
    // ИИ следит за мячом только когда тот летит в его сторону — как человек,
    // не умеющий "видеть" всё поле идеально. Скорость реакции ограничена.
    const maxSpeed = 260 + this.botDifficulty * 260; // px/sec
    let target = FIELD_H / 2;

    if (this.ballVX > 0) {
      target = this.ballY;
    }
    // Небольшая неидеальность прицела для ощущения живого противника
    const jitter = (1 - this.botDifficulty) * 40;
    target += (Math.sin(performance.now() / 210) * jitter);

    const delta = target - this.rightY;
    const maxStep = maxSpeed * dt;
    this.rightY += Math.max(-maxStep, Math.min(maxStep, delta));
    this.rightY = Math.min(FIELD_H - PADDLE_H / 2, Math.max(PADDLE_H / 2, this.rightY));
  }

  render() {
    const ctx = this.ctx;
    const { width, height } = { width: FIELD_W, height: FIELD_H };
    ctx.clearRect(0, 0, width, height);

    // фон
    ctx.fillStyle = '#04060d';
    ctx.fillRect(0, 0, width, height);

    // рамка поля
    ctx.save();
    ctx.strokeStyle = '#2fe8ff';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#2fe8ff';
    ctx.shadowBlur = 18;
    ctx.strokeRect(4, 4, width - 8, height - 8);
    ctx.restore();

    // центральная линия
    ctx.save();
    ctx.strokeStyle = 'rgba(234,246,255,0.55)';
    ctx.shadowColor = '#eaf6ff';
    ctx.shadowBlur = 10;
    ctx.setLineDash([10, 14]);
    ctx.beginPath();
    ctx.moveTo(width / 2, 10);
    ctx.lineTo(width / 2, height - 10);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // левая ракетка (синяя)
    this._drawPaddle(20, this.leftY, '#2fe8ff');
    // правая ракетка (розовая)
    this._drawPaddle(width - 20 - PADDLE_W, this.rightY, '#ff2fb0');

    // мяч
    ctx.save();
    ctx.fillStyle = '#eaf6ff';
    ctx.shadowColor = '#eaf6ff';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(this.ballX, this.ballY, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawPaddle(x, centerY, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    const y = centerY - PADDLE_H / 2;
    const radius = 6;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + PADDLE_W, y, x + PADDLE_W, y + radius, radius);
    ctx.arcTo(x + PADDLE_W, y + PADDLE_H, x + PADDLE_W - radius, y + PADDLE_H, radius);
    ctx.arcTo(x, y + PADDLE_H, x, y + PADDLE_H - radius, radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
