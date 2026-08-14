"use strict";

/* ---------- 状態 ---------- */
const state = {
  playing: false,
  noiseType: localStorage.getItem("noiseType") || "pink",
  volume: Number(localStorage.getItem("volume") ?? 50),
  freq: Number(localStorage.getItem("freq") ?? 4000),
  notch: localStorage.getItem("notch") === "1",
  tonePlaying: false,
  timerEnd: null,
  timerId: null,
};

/* ---------- Web Audio ---------- */
let ctx = null;
let masterGain, noiseGain, toneGain;
let noiseSrc = null, toneOsc = null;
let notchFilters = [];       // カスケード接続のノッチフィルタ
let noiseChainIn = null;     // ノイズの接続先（ノッチ有無で切替）
const NOTCH_STAGES = 4;      // 段数を重ねて深いノッチにする
const FMIN = 200, FMAX = 15000; // マッチング範囲(Hz) 対数スケール

function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  // iOS: サイレントスイッチが入っていても再生されるようにする
  if (navigator.audioSession) {
    try { navigator.audioSession.type = "playback"; } catch (e) {}
  }
  masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);

  noiseGain = ctx.createGain();
  noiseGain.gain.value = state.volume / 100;

  toneGain = ctx.createGain();
  toneGain.gain.value = 0;
  toneGain.connect(masterGain);

  // ノッチフィルタのカスケードを常設し，バイパスは接続の付け替えで行う
  notchFilters = [];
  for (let i = 0; i < NOTCH_STAGES; i++) {
    const f = ctx.createBiquadFilter();
    f.type = "notch";
    f.Q.value = 1.4; // 約1オクターブ幅
    notchFilters.push(f);
    if (i > 0) notchFilters[i - 1].connect(f);
  }
  notchFilters[NOTCH_STAGES - 1].connect(masterGain);
  updateNotchFreq();
  rewireNoise();
}

function rewireNoise() {
  noiseGain.disconnect();
  if (state.notch) {
    noiseGain.connect(notchFilters[0]);
  } else {
    noiseGain.connect(masterGain);
  }
}

function updateNotchFreq() {
  if (!ctx) return;
  for (const f of notchFilters) f.frequency.setValueAtTime(state.freq, ctx.currentTime);
}

/* ノイズバッファ生成（4秒ループ） */
function makeNoiseBuffer(type) {
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    if (type === "white") {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } else if (type === "pink") {
      // Paul Kellet 法
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else if (type === "brown") {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    } else if (type === "rain") {
      // ピンクノイズに揺らぎを重ねた簡易レイン
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + w * 0.03;
        b1 = 0.985 * b1 + w * 0.09;
        b2 = 0.950 * b2 + w * 0.18;
        const slow = 0.75 + 0.25 * Math.sin((i / ctx.sampleRate) * 2 * Math.PI * 0.13 + ch);
        let v = (b0 + b1 + b2) * 0.9 * slow;
        // 雨粒のランダムなプチプチ感
        if (Math.random() < 0.00012) v += (Math.random() * 2 - 1) * 0.6;
        d[i] = v;
      }
    }
  }
  return buf;
}

function startNoise() {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  stopNoiseSrc();
  noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = makeNoiseBuffer(state.noiseType);
  noiseSrc.loop = true;
  noiseSrc.connect(noiseGain);
  // クリック防止のフェードイン
  noiseGain.gain.cancelScheduledValues(ctx.currentTime);
  noiseGain.gain.setValueAtTime(0, ctx.currentTime);
  noiseGain.gain.linearRampToValueAtTime(state.volume / 100, ctx.currentTime + 0.4);
  noiseSrc.start();
  state.playing = true;
  updatePlayBtn();
}

function stopNoiseSrc() {
  if (noiseSrc) { try { noiseSrc.stop(); } catch (e) {} noiseSrc.disconnect(); noiseSrc = null; }
}

function stopNoise() {
  if (!ctx || !state.playing) return;
  const src = noiseSrc;
  noiseSrc = null;
  noiseGain.gain.cancelScheduledValues(ctx.currentTime);
  noiseGain.gain.setValueAtTime(noiseGain.gain.value, ctx.currentTime);
  noiseGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
  if (src) setTimeout(() => { try { src.stop(); src.disconnect(); } catch (e) {} }, 400);
  state.playing = false;
  updatePlayBtn();
}

/* ---------- テスト音（周波数マッチング用） ---------- */
function startTone() {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  stopTone();
  toneOsc = ctx.createOscillator();
  toneOsc.type = "sine";
  toneOsc.frequency.value = state.freq;
  toneOsc.connect(toneGain);
  toneGain.gain.cancelScheduledValues(ctx.currentTime);
  toneGain.gain.setValueAtTime(0, ctx.currentTime);
  toneGain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.15);
  toneOsc.start();
  state.tonePlaying = true;
  document.getElementById("toneBtn").classList.add("active");
}

function stopTone() {
  if (toneOsc) {
    const osc = toneOsc;
    toneOsc = null;
    toneGain.gain.cancelScheduledValues(ctx.currentTime);
    toneGain.gain.setValueAtTime(toneGain.gain.value, ctx.currentTime);
    toneGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
    setTimeout(() => { try { osc.stop(); osc.disconnect(); } catch (e) {} }, 200);
  }
  state.tonePlaying = false;
  document.getElementById("toneBtn").classList.remove("active");
}

/* ---------- 周波数スライダー（対数スケール） ---------- */
function sliderToFreq(v) {
  return Math.round(FMIN * Math.pow(FMAX / FMIN, v / 1000));
}
function freqToSlider(f) {
  return Math.round(1000 * Math.log(f / FMIN) / Math.log(FMAX / FMIN));
}

function setFreq(f, fromSlider) {
  state.freq = Math.min(FMAX, Math.max(FMIN, Math.round(f)));
  localStorage.setItem("freq", state.freq);
  document.getElementById("freqValue").textContent = state.freq;
  if (!fromSlider) document.getElementById("freqSlider").value = freqToSlider(state.freq);
  if (ctx) {
    if (toneOsc) toneOsc.frequency.setValueAtTime(state.freq, ctx.currentTime);
    updateNotchFreq();
  }
}

/* ---------- スリープタイマー ---------- */
const FADE_SEC = 120;
function setTimer(min) {
  clearInterval(state.timerId);
  state.timerId = null;
  state.timerEnd = null;
  if (ctx && state.playing) {
    // 進行中のフェードを取り消して音量を戻す
    noiseGain.gain.cancelScheduledValues(ctx.currentTime);
    noiseGain.gain.setValueAtTime(state.volume / 100, ctx.currentTime);
  }
  if (min > 0) {
    state.timerEnd = Date.now() + min * 60000;
    state.timerId = setInterval(tickTimer, 1000);
    if (ctx && state.playing) scheduleFade();
  }
  updateTimerUI(min);
}

function scheduleFade() {
  const remain = (state.timerEnd - Date.now()) / 1000;
  if (remain <= 0) return;
  const fadeStart = Math.max(0, remain - FADE_SEC);
  noiseGain.gain.cancelScheduledValues(ctx.currentTime);
  noiseGain.gain.setValueAtTime(state.volume / 100, ctx.currentTime + fadeStart);
  noiseGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + remain);
}

function tickTimer() {
  const remain = state.timerEnd - Date.now();
  if (remain <= 0) {
    clearInterval(state.timerId);
    state.timerId = null;
    state.timerEnd = null;
    stopNoise();
    stopTone();
    updateTimerUI(0);
    return;
  }
  const m = Math.floor(remain / 60000);
  const s = Math.floor((remain % 60000) / 1000);
  document.getElementById("timerStatus").textContent =
    `残り ${m}:${String(s).padStart(2, "0")}`;
}

function updateTimerUI(activeMin) {
  document.querySelectorAll("#timerBtns button").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.min) === activeMin && activeMin > 0);
  });
  if (!state.timerEnd) document.getElementById("timerStatus").textContent = "";
}

/* ---------- UI 配線 ---------- */
function updatePlayBtn() {
  const btn = document.getElementById("playBtn");
  btn.textContent = state.playing ? "■ 停止" : "▶ 再生";
  btn.classList.toggle("playing", state.playing);
}

document.getElementById("playBtn").addEventListener("click", () => {
  if (state.playing) { stopNoise(); }
  else {
    startNoise();
    if (state.timerEnd) scheduleFade();
  }
});

document.querySelectorAll("#noiseTypes button").forEach(btn => {
  btn.addEventListener("click", () => {
    state.noiseType = btn.dataset.type;
    localStorage.setItem("noiseType", state.noiseType);
    document.querySelectorAll("#noiseTypes button").forEach(b =>
      b.classList.toggle("active", b === btn));
    if (state.playing) startNoise(); // 再生中なら即切替
  });
});

document.getElementById("volume").addEventListener("input", e => {
  state.volume = Number(e.target.value);
  localStorage.setItem("volume", state.volume);
  if (ctx && state.playing && !state.timerEnd) {
    noiseGain.gain.cancelScheduledValues(ctx.currentTime);
    noiseGain.gain.setTargetAtTime(state.volume / 100, ctx.currentTime, 0.05);
  }
});

document.getElementById("freqSlider").addEventListener("input", e => {
  setFreq(sliderToFreq(Number(e.target.value)), true);
});
document.getElementById("fineDown").addEventListener("click", () => setFreq(state.freq * 0.97));
document.getElementById("fineUp").addEventListener("click", () => setFreq(state.freq * 1.03));

document.getElementById("toneBtn").addEventListener("click", () => {
  if (state.tonePlaying) stopTone(); else startTone();
});

document.getElementById("notchToggle").addEventListener("change", e => {
  state.notch = e.target.checked;
  localStorage.setItem("notch", state.notch ? "1" : "0");
  if (ctx) rewireNoise();
});

document.querySelectorAll("#timerBtns button").forEach(btn => {
  btn.addEventListener("click", () => setTimer(Number(btn.dataset.min)));
});

/* ---------- 初期化 ---------- */
(function init() {
  document.getElementById("volume").value = state.volume;
  document.getElementById("notchToggle").checked = state.notch;
  setFreq(state.freq);
  document.querySelectorAll("#noiseTypes button").forEach(b =>
    b.classList.toggle("active", b.dataset.type === state.noiseType));
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
