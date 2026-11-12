// ykg-sfx.js（2026-11-13 作成）: ミニゲーム集で共通の「音と振動」。
// シールドファイトと同じく、音のファイルは使わず、その場で音を作る（Web Audio）。
//   - 最初に画面にふれたときに音の準備をする（スマホは、ふれる前は音を出せない）。
//   - ボタン（<button>）を押すと、自動で「カチッ」と鳴る。鳴らしたくないボタンには data-nosfx を付ける。
//   - 音を消す設定は全部のゲームで共通（localStorage "ykg-muted"）。YkgSfx.toggleButton() で切り替えボタンを作れる。
//   - 振動は Android など対応している端末だけ（iPhone は振動しない）。音を消していると振動もしない。
//   - アプリを裏にしたら止め、表に戻ったら再開する（止まっている間の音がまとめて鳴らないように）。
// 使い方: <script src="../ykg-sfx.js?v=1"></script> を読み込み、YkgSfx.turn() / YkgSfx.win() などを呼ぶ。
(function () {
  if (window.YkgSfx) return;
  let ac = null, master = null, buf = null, muted = false;
  try { muted = localStorage.getItem("ykg-muted") === "1"; } catch (e) {}
  const VOL = 0.55;
  const listeners = new Set();

  function init() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { ac = new AC(); } catch (e) { ac = null; return; }
      master = ac.createGain(); master.gain.value = muted ? 0 : VOL; master.connect(ac.destination);
      buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);   // ノイズの素材（1 秒）
      const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === "suspended" && !document.hidden) { try { const r = ac.resume(); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
  }
  const ready = () => ac && !muted && !document.hidden && ac.state === "running";
  const env = (g, t0, dur, vol) => {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  };
  function tone(f0, f1, dur, type, vol, delay) {   // f0 → f1 に音程が動く音
    if (!ready()) return;
    const t0 = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    env(g, t0, dur, vol); o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function noise(dur, vol, type, f0, f1, delay) {   // フィルターを通したノイズ
    if (!ready()) return;
    const t0 = ac.currentTime + (delay || 0), s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = buf; f.type = type; f.Q.value = 1; f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    env(g, t0, dur, vol); s.connect(f); f.connect(g); g.connect(master); s.start(t0, Math.random() * 0.3); s.stop(t0 + dur + 0.03);
  }
  const notes = (fs, step, type, vol, dur, delay) => fs.forEach((f, i) => tone(f, f, dur || 0.15, type || "triangle", vol || 0.16, (delay || 0) + i * step));
  function vibrate(p) {
    if (muted) return;
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {}
  }

  // 最初にふれたとき・キーを押したときに音の準備（毎回呼んでも軽い）
  const unlock = () => init();
  addEventListener("pointerdown", unlock, true);
  addEventListener("keydown", unlock, true);
  addEventListener("touchend", unlock, true);
  // 裏になったら止める・表に戻ったら再開
  document.addEventListener("visibilitychange", () => {
    if (!ac) return;
    try {
      const r = document.hidden ? (ac.state === "running" ? ac.suspend() : null) : (ac.state === "suspended" ? ac.resume() : null);
      if (r && r.catch) r.catch(() => {});
    } catch (e) {}
  });
  // ボタンを押したら「カチッ」（無効なボタン・data-nosfx は鳴らさない）
  addEventListener("click", e => {
    const b = e.target && e.target.closest && e.target.closest("button");
    if (!b || b.disabled || b.hasAttribute("data-nosfx") || b.closest("[data-nosfx]")) return;
    init(); S.tap();
  }, true);

  const S = window.YkgSfx = {
    init,
    get muted() { return muted; },
    setMuted(m) {
      muted = !!m;
      try { localStorage.setItem("ykg-muted", muted ? "1" : "0"); } catch (e) {}
      if (master) master.gain.value = muted ? 0 : VOL;
      listeners.forEach(fn => { try { fn(muted); } catch (e) {} });
    },
    toggle() { S.setMuted(!muted); if (!muted) { init(); S.select(); } return muted; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // 音のオン・オフを切り替えるボタン（ゲームのメニューや設定に置く）。cls でゲームのボタンの見た目に合わせる
    toggleButton(cls) {
      const b = document.createElement("button");
      b.type = "button"; b.className = cls || ""; b.setAttribute("data-nosfx", "");
      const upd = () => { b.textContent = muted ? "🔇 音：オフ" : "🔊 音：オン"; b.setAttribute("aria-pressed", muted ? "false" : "true"); };
      upd(); S.onChange(upd);
      b.addEventListener("click", () => S.toggle());
      return b;
    },
    vibrate,

    // ---- 画面の操作 ----
    tap() { tone(1250, 1050, 0.035, "square", 0.035); },                         // ボタン（自動で鳴る）
    select() { tone(880, 1320, 0.07, "triangle", 0.10); },                         // えらんだ
    cancel() { tone(700, 420, 0.08, "triangle", 0.08); },                          // やめた・もどした
    error() { tone(220, 180, 0.09, "square", 0.07); tone(220, 180, 0.09, "square", 0.07, 0.11); vibrate(40); },   // できない操作

    // ---- 試合の流れ ----
    turn() { notes([660, 990], 0.11, "triangle", 0.17, 0.16); vibrate([60, 60, 60]); },   // 自分の番になった
    count(n) { tone(660, 660, 0.12, "square", 0.08); },                             // 3・2・1
    go() { tone(990, 990, 0.32, "square", 0.10); vibrate(80); },                    // スタート
    tick(urgent) { const f = urgent ? 1180 : 880; tone(f, f, 0.06, "square", 0.06); if (urgent) vibrate(20); },   // 残り時間
    warn() { notes([880, 880], 0.16, "square", 0.08, 0.08); vibrate([40, 80, 40]); },   // 残り 10 秒など
    win() { notes([523, 659, 784, 1047, 784, 1047], 0.12, "triangle", 0.18, 0.17, 0.15); vibrate([80, 60, 80, 60, 160]); },
    lose() { notes([523, 440, 392, 330, 294, 262], 0.12, "triangle", 0.16, 0.17, 0.15); vibrate(300); },
    draw() { notes([523, 523, 392], 0.16, "triangle", 0.15, 0.18, 0.15); },
    join() { notes([784, 1175], 0.08, "sine", 0.10, 0.10); },                      // だれかが来た
    leave() { notes([784, 523], 0.09, "sine", 0.09, 0.11); },                       // だれかが抜けた

    // ---- ゲームの中の音（よく使うもの） ----
    pick() { tone(520, 780, 0.06, "sine", 0.10); },                                 // つまむ・持ち上げる
    place() { noise(0.06, 0.22, "bandpass", 900, 600); tone(180, 120, 0.08, "sine", 0.18); },   // コトッ（木を置く）
    knock() { noise(0.05, 0.26, "bandpass", 1600, 1100); tone(320, 220, 0.05, "triangle", 0.12); },   // カツッ（駒・硬いもの）
    creak() { tone(140, 170, 0.28, "sawtooth", 0.035); noise(0.25, 0.05, "bandpass", 700, 900); },   // ギギッ（こすれる）
    crash() { noise(0.9, 0.4, "lowpass", 1800, 120); tone(110, 40, 0.7, "sine", 0.4); notes([300, 240, 200], 0.09, "triangle", 0.08, 0.12, 0.1); vibrate([120, 60, 200]); },   // 崩れる
    shot() { noise(0.10, 0.16, "bandpass", 600, 2200); tone(300, 700, 0.08, "triangle", 0.08); },   // 飛ばす・はじく
    bounce() { tone(420, 300, 0.05, "sine", 0.10); },                               // 壁などに当たる
    hit() { tone(190, 60, 0.18, "sine", 0.35); noise(0.08, 0.18, "lowpass", 2400, 500); vibrate(30); },   // 攻撃が当たる
    damage() { tone(160, 50, 0.25, "sawtooth", 0.12); noise(0.12, 0.2, "lowpass", 1400, 300); vibrate([50, 30, 50]); },   // 自分がやられた
    guard() { tone(920, 900, 0.14, "triangle", 0.16); tone(1380, 1350, 0.10, "square", 0.04); },   // 防いだ
    breakGuard() { noise(0.45, 0.24, "highpass", 2500, 7000); tone(1900, 320, 0.28, "triangle", 0.14); vibrate(60); },   // バリアなどが割れた
    charge() { tone(330, 660, 0.12, "sine", 0.09); },                               // ためる
    coin() { tone(1320, 1320, 0.05, "square", 0.06); tone(1760, 1760, 0.12, "square", 0.06, 0.05); },   // 資源・点が入る
    dice() { for (let i = 0; i < 6; i++) noise(0.03, 0.18, "bandpass", 2000 + i * 150, 1500, i * 0.055); tone(260, 200, 0.06, "triangle", 0.1, 0.34); },   // サイコロ
    build() { notes([392, 523, 659], 0.06, "triangle", 0.12, 0.09); noise(0.05, 0.12, "bandpass", 900, 600, 0.18); },   // 建てた
    card() { noise(0.08, 0.10, "highpass", 2500, 5000); tone(900, 1300, 0.06, "sine", 0.06); },   // カードをめくる
    miss() { tone(500, 300, 0.12, "triangle", 0.08); },                             // はずれ・不発
  };
})();
