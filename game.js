(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  const scoreEl = document.getElementById("score");
  const highEl = document.getElementById("high");

  // ---- Tuning (pixels and seconds) ----
  const GRAVITY = 1500;
  const FLAP_VELOCITY = -430;
  const MAX_FALL_SPEED = 700;
  const PIPE_SPEED = 170;
  const PIPE_SPACING = 230; // horizontal distance between pipe pairs
  const PIPE_WIDTH = 52;
  const CAP_WIDTH = 62;
  const CAP_HEIGHT = 20;
  const GAP = 165;
  const GAP_MARGIN = 70; // min distance of gap from top/bottom
  const CLOUD_SPEED = 35;
  const GHOST_W = 36;
  const GHOST_H = 43;
  const GHOST_X = W * 0.42;
  const RESTART_DELAY = 0.6; // seconds before input can restart after death

  // ---- Assets ----
  const ghostImg = new Image();
  let ghostReady = false;
  ghostImg.onload = () => (ghostReady = true);
  ghostImg.src = "assets/ghosty.png";

  const jumpSound = new Audio("assets/jump.wav");
  const gameOverSound = new Audio("assets/game_over.wav");
  jumpSound.volume = 0.5;
  gameOverSound.volume = 0.6;

  function play(sound) {
    try {
      sound.currentTime = 0;
      const p = sound.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {
      /* audio not available */
    }
  }

  // ---- High score ----
  const HIGH_KEY = "flappyKiroHigh";
  let high = 0;
  try {
    high = parseInt(localStorage.getItem(HIGH_KEY), 10) || 0;
  } catch (_) {
    high = 0;
  }

  // ---- Sketchy painted background (pre-rendered once) ----
  const bg = document.createElement("canvas");
  bg.width = W;
  bg.height = H;
  (function paintBackground() {
    const b = bg.getContext("2d");
    b.fillStyle = "#8fd0ec";
    b.fillRect(0, 0, W, H);
    b.lineCap = "round";
    // Mostly vertical brush strokes in lighter/darker blues
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const len = 10 + Math.random() * 70;
      const angle = Math.PI / 2 + (Math.random() - 0.5) * 0.5;
      const light = Math.random() < 0.5;
      b.strokeStyle = light
        ? `rgba(200, 235, 250, ${0.08 + Math.random() * 0.15})`
        : `rgba(90, 160, 200, ${0.06 + Math.random() * 0.12})`;
      b.lineWidth = 0.6 + Math.random() * 1.6;
      b.beginPath();
      b.moveTo(x, y);
      b.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
      b.stroke();
    }
    // A few horizontal scratches
    for (let i = 0; i < 250; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const len = 15 + Math.random() * 60;
      b.strokeStyle = `rgba(110, 175, 210, ${0.05 + Math.random() * 0.1})`;
      b.lineWidth = 0.6 + Math.random();
      b.beginPath();
      b.moveTo(x, y);
      b.lineTo(x + len, y + (Math.random() - 0.5) * 6);
      b.stroke();
    }
  })();

  // ---- Clouds ----
  function makeCloudSprite(w, h) {
    const pad = 40;
    const c = document.createElement("canvas");
    c.width = w + pad * 2;
    c.height = h + pad * 2;
    const g = c.getContext("2d");
    // Scribbled halo around the cloud
    g.lineCap = "round";
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.55 + Math.random() * 0.35;
      const cx = c.width / 2 + Math.cos(a) * (w / 2 + pad) * r;
      const cy = c.height / 2 + Math.sin(a) * (h / 2 + pad) * r;
      g.strokeStyle = `rgba(80, 150, 195, ${0.05 + Math.random() * 0.1})`;
      g.lineWidth = 1 + Math.random() * 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + (Math.random() - 0.5) * 30, cy + (Math.random() - 0.5) * 30);
      g.stroke();
    }
    // Cloud body: soft rounded rectangle
    roundRect(g, pad, pad, w, h, Math.min(16, h / 2.5));
    g.fillStyle = "#eef8fd";
    g.fill();
    g.strokeStyle = "rgba(150, 200, 225, 0.9)";
    g.lineWidth = 2;
    g.stroke();
    return { canvas: c, pad };
  }

  function newCloud(x) {
    const w = 60 + Math.random() * 50;
    const h = 40 + Math.random() * 12;
    const sprite = makeCloudSprite(w, h);
    return { x, y: 30 + Math.random() * (H * 0.65), w, sprite };
  }

  let clouds = [];
  function resetClouds() {
    clouds = [];
    let x = 30;
    while (x < W + 100) {
      clouds.push(newCloud(x));
      x += 150 + Math.random() * 150;
    }
  }

  function updateClouds(dt) {
    for (const c of clouds) c.x -= CLOUD_SPEED * dt;
    clouds = clouds.filter((c) => c.x + c.w + c.sprite.pad > 0);
    const last = clouds[clouds.length - 1];
    if (!last || last.x < W - 150) {
      clouds.push(newCloud(W + 40 + Math.random() * 120));
    }
  }

  function drawClouds() {
    for (const c of clouds) {
      ctx.drawImage(c.sprite.canvas, c.x - c.sprite.pad, c.y - c.sprite.pad);
    }
  }

  // ---- Game state ----
  let state = "ready"; // ready | playing | over
  let ghost;
  let pipes;
  let score;
  let overTimer = 0;
  let time = 0;

  function reset() {
    ghost = { y: H / 2 - GHOST_H / 2, vy: 0, rot: 0 };
    pipes = [];
    score = 0;
    overTimer = 0;
    state = "ready";
    updateScoreBar();
  }

  function updateScoreBar() {
    scoreEl.textContent = score;
    highEl.textContent = high;
  }

  function spawnPipe(x) {
    const minTop = GAP_MARGIN;
    const maxTop = H - GAP_MARGIN - GAP;
    const gapTop = minTop + Math.random() * (maxTop - minTop);
    pipes.push({ x, gapTop, passed: false });
  }

  function flap() {
    if (state === "ready") {
      state = "playing";
      spawnPipe(W + 40);
    }
    if (state === "playing") {
      ghost.vy = FLAP_VELOCITY;
      play(jumpSound);
    } else if (state === "over" && overTimer >= RESTART_DELAY) {
      reset();
    }
  }

  function die() {
    if (state !== "playing") return;
    state = "over";
    overTimer = 0;
    play(gameOverSound);
    if (score > high) {
      high = score;
      try {
        localStorage.setItem(HIGH_KEY, String(high));
      } catch (_) {
        /* storage unavailable */
      }
    }
    updateScoreBar();
  }

  // Ghost hitbox is a bit smaller than the sprite for fair collisions
  function ghostBox() {
    const insetX = 6;
    const insetY = 5;
    return {
      x: GHOST_X + insetX,
      y: ghost.y + insetY,
      w: GHOST_W - insetX * 2,
      h: GHOST_H - insetY * 2,
    };
  }

  function intersects(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function update(dt) {
    time += dt;
    updateClouds(dt);

    if (state === "ready") {
      ghost.y = H / 2 - GHOST_H / 2 + Math.sin(time * 3) * 8;
      ghost.rot = 0;
      return;
    }

    if (state === "over") {
      overTimer += dt;
      // Let the ghost fall to the ground after death
      if (ghost.y + GHOST_H < H) {
        ghost.vy = Math.min(ghost.vy + GRAVITY * dt, MAX_FALL_SPEED);
        ghost.y = Math.min(ghost.y + ghost.vy * dt, H - GHOST_H);
        ghost.rot = Math.min(ghost.rot + 4 * dt, Math.PI / 2);
      }
      return;
    }

    // Playing
    ghost.vy = Math.min(ghost.vy + GRAVITY * dt, MAX_FALL_SPEED);
    ghost.y += ghost.vy * dt;
    ghost.rot = Math.max(-0.4, Math.min(ghost.vy / 900, 1.0));

    if (ghost.y < 0) {
      ghost.y = 0;
      ghost.vy = 0;
    }

    for (const p of pipes) p.x -= PIPE_SPEED * dt;
    pipes = pipes.filter((p) => p.x + CAP_WIDTH > -10);
    const last = pipes[pipes.length - 1];
    if (last && last.x < W - PIPE_SPACING) spawnPipe(last.x + PIPE_SPACING);

    const box = ghostBox();
    for (const p of pipes) {
      const capX = p.x - (CAP_WIDTH - PIPE_WIDTH) / 2;
      const rects = [
        { x: p.x, y: 0, w: PIPE_WIDTH, h: p.gapTop - CAP_HEIGHT },
        { x: capX, y: p.gapTop - CAP_HEIGHT, w: CAP_WIDTH, h: CAP_HEIGHT },
        { x: capX, y: p.gapTop + GAP, w: CAP_WIDTH, h: CAP_HEIGHT },
        { x: p.x, y: p.gapTop + GAP + CAP_HEIGHT, w: PIPE_WIDTH, h: H },
      ];
      if (rects.some((r) => intersects(box, r))) {
        die();
        return;
      }
      if (!p.passed && p.x + PIPE_WIDTH < GHOST_X) {
        p.passed = true;
        score++;
        updateScoreBar();
      }
    }

    if (ghost.y + GHOST_H >= H) {
      ghost.y = H - GHOST_H;
      die();
    }
  }

  // ---- Drawing ----
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  function drawPipeBody(x, y, w, h) {
    if (h <= 0) return;
    ctx.fillStyle = "#3a9a34";
    ctx.fillRect(x, y, w, h);
    // Painted streaks
    ctx.fillStyle = "rgba(120, 200, 100, 0.35)";
    ctx.fillRect(x + 8, y, 5, h);
    ctx.fillStyle = "rgba(20, 90, 20, 0.35)";
    ctx.fillRect(x + w - 12, y, 6, h);
    ctx.fillStyle = "rgba(90, 180, 80, 0.25)";
    ctx.fillRect(x + 20, y, 3, h);
    ctx.strokeStyle = "#1d5e1a";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y, w - 2, h);
  }

  function drawCap(x, y) {
    ctx.fillStyle = "#1f7a1d";
    ctx.fillRect(x, y, CAP_WIDTH, CAP_HEIGHT);
    ctx.fillStyle = "rgba(80, 160, 70, 0.35)";
    ctx.fillRect(x + 4, y + 3, CAP_WIDTH - 8, 4);
    ctx.strokeStyle = "#154d13";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CAP_WIDTH - 2, CAP_HEIGHT - 2);
  }

  function drawPipes() {
    for (const p of pipes) {
      const capX = p.x - (CAP_WIDTH - PIPE_WIDTH) / 2;
      const bottomTop = p.gapTop + GAP;
      drawPipeBody(p.x, 0, PIPE_WIDTH, p.gapTop - CAP_HEIGHT);
      drawCap(capX, p.gapTop - CAP_HEIGHT);
      drawCap(capX, bottomTop);
      drawPipeBody(p.x, bottomTop + CAP_HEIGHT, PIPE_WIDTH, H - bottomTop - CAP_HEIGHT);
    }
  }

  function drawGhost() {
    ctx.save();
    ctx.translate(GHOST_X + GHOST_W / 2, ghost.y + GHOST_H / 2);
    ctx.rotate(ghost.rot);
    if (ghostReady) {
      ctx.drawImage(ghostImg, -GHOST_W / 2, -GHOST_H / 2, GHOST_W, GHOST_H);
    } else {
      // Fallback shape until the sprite loads
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(0, -4, GHOST_W / 2, Math.PI, 0);
      ctx.lineTo(GHOST_W / 2, GHOST_H / 2);
      ctx.lineTo(-GHOST_W / 2, GHOST_H / 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCenteredText(text, y, size, color = "#ffffff") {
    ctx.font = `bold ${size}px "Press Start 2P", "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(4, size / 6);
    ctx.strokeStyle = "#34465a";
    ctx.strokeText(text, W / 2, y);
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, y);
  }

  function drawOverlay() {
    if (state === "ready") {
      drawCenteredText("FLAPPY KIRO", H * 0.25, 56);
      drawCenteredText("Click, tap or press Space to flap", H * 0.68, 22);
    } else if (state === "over") {
      ctx.fillStyle = "rgba(30, 42, 56, 0.35)";
      ctx.fillRect(0, 0, W, H);
      drawCenteredText("GAME OVER", H * 0.36, 60, "#ffffff");
      drawCenteredText(`Score: ${score}   High: ${high}`, H * 0.5, 26);
      if (overTimer >= RESTART_DELAY) {
        drawCenteredText("Click, tap or press Space to restart", H * 0.62, 20);
      }
    }
  }

  function draw() {
    ctx.drawImage(bg, 0, 0);
    drawClouds();
    drawPipes();
    drawGhost();
    drawOverlay();
  }

  // ---- Input ----
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
      e.preventDefault();
      if (!e.repeat) flap();
    }
  });
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    flap();
  });

  // ---- Main loop ----
  let lastTime = performance.now();
  function frame(now) {
    // Clamp dt so a background tab doesn't cause a huge physics jump
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  resetClouds();
  reset();
  requestAnimationFrame(frame);
})();
