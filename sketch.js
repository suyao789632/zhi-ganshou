const VIDEO_W = 320;
const VIDEO_H = 240;
const PINCH_THRESHOLD = 60;
const NOTE_TRIGGER_GAP_MS = 160;
const HAND_STABLE_MS = 250;
const EXPLOSION_COOLDOWN_MS = 500;
const MAX_PINCH_HOLD_MS = 2500;

let particles = [];
let cols, rows, flowField, scl = 60, zoff = 0;
let maxParticles = 1500;
let started = false;
let cameraReady = false;
let cameraTimer;

let video;
let handPose;
let hands = [];
let rightHandIndex = -1;
let leftHandIndex = -1;
let rightHandPos = { x: -1000, y: -1000 };
let leftHandPos = { x: -1000, y: -1000 };
let isPinching = false, wasPinching = false;
let holdStartTime = 0;
let blackHoleStrength = 0;
let ripples = [];
let smoothFactor = 0.2;

let handpanSynth, xylophoneSynth, reverb, delayEffect;
let limiter, compressor;
let currentXyloNote = "";
let lastXyloTrigger = 0;
let leftHandStableSince = 0;
let rightHandStableSince = 0;
let lastExplosionAt = 0;

const starryColors = [
  [25, 25, 112], [65, 105, 225], [30, 191, 255],
  [255, 215, 0], [255, 140, 0], [72, 61, 139]
];
const handpanScale = ["D4", "F4", "A4", "Bb4", "C5", "D5", "E5", "F5", "A5"];
const xyloScale = ["D3", "F3", "G3", "A3", "C4", "D4", "F4", "G4", "A4", "C5", "D5", "F5", "G5"];

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.style.color = isError ? "#ffaaa1" : "#dbe4ff";
  status.style.borderColor = isError ? "rgba(255,120,120,.55)" : "rgba(255,255,255,.14)";
}

function showCameraError() {
  setStatus("攝影機未能啟動。請允許網站使用攝影機，或確認鏡頭沒有被其他程式占用。", true);
  const startButton = document.getElementById("startButton");
  const retryButton = document.getElementById("retryButton");
  startButton.style.display = "none";
  retryButton.style.display = "block";
}

function preload() {
  handPose = ml5.handPose({ flipped: true, maxHands: 2 });
}

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.attribute("aria-label", "指感受粒子互動畫布");
  pixelDensity(1);

  initFlowField();
  for (let i = 0; i < maxParticles; i++) particles.push(new Particle(random(width), random(height), true));
  background(10, 10, 30);

  // 留出足夠的音量餘裕，避免多個殘響或延遲聲部疊加時產生爆音。
  limiter = new Tone.Limiter(-6).toDestination();
  compressor = new Tone.Compressor({ threshold: -24, ratio: 6, attack: 0.01, release: 0.3 }).connect(limiter);
  reverb = new Tone.Reverb({ decay: 2.5, wet: 0.28 }).connect(compressor);
  delayEffect = new Tone.FeedbackDelay({ delayTime: "8n", feedback: 0, wet: 0.2 }).connect(reverb);
  handpanSynth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 6,
    oscillator: { type: "sine" },
    envelope: { attack: 0.02, decay: 0.65, sustain: 0.04, release: 1.2 }
  }).connect(reverb);
  handpanSynth.volume.value = -8;
  xylophoneSynth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 6,
    oscillator: { type: "sine" },
    envelope: { attack: 0.012, decay: 0.16, sustain: 0, release: 0.35 }
  }).connect(delayEffect);
  xylophoneSynth.volume.value = -10;

  document.getElementById("startButton").addEventListener("click", startExperience);
  document.getElementById("retryButton").addEventListener("click", () => location.reload());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) resetAudioInteraction();
  });
  window.addEventListener("blur", resetAudioInteraction);
  startCamera();
}

function startCamera() {
  setStatus("請在瀏覽器提示中選擇「允許攝影機」");
  video = createCapture({
    video: {
      width: { ideal: VIDEO_W },
      height: { ideal: VIDEO_H },
      facingMode: "user"
    },
    audio: false
  }, () => {
    clearTimeout(cameraTimer);
    cameraReady = true;
    video.size(VIDEO_W, VIDEO_H);
    video.hide();
    handPose.detectStart(video, gotHands);
    const startButton = document.getElementById("startButton");
    startButton.disabled = false;
    startButton.textContent = "啟用聲音並開始互動";
    setStatus("攝影機已啟動，請按按鈕開始互動");
  });
  video.elt.setAttribute("playsinline", "");
  video.elt.muted = true;
  video.hide();
  cameraTimer = setTimeout(() => { if (!cameraReady) showCameraError(); }, 12000);
}

async function startExperience() {
  if (!cameraReady) return;
  const startButton = document.getElementById("startButton");
  startButton.disabled = true;
  try {
    await Tone.start();
    started = true;
    document.getElementById("startLayer").classList.add("is-hidden");
    document.getElementById("instruction-panel").style.opacity = "1";
    setStatus("攝影機與聲音已啟動，請將雙手移入鏡頭範圍");
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  } catch (error) {
    startButton.disabled = false;
    startButton.textContent = "重新啟用聲音";
    setStatus("聲音未能啟動，請再按一次按鈕", true);
  }
}

function gotHands(results) {
  const previousRightHandIndex = rightHandIndex;
  const previousLeftHandIndex = leftHandIndex;
  hands = results;
  rightHandIndex = -1;
  leftHandIndex = -1;
  for (let i = 0; i < hands.length; i++) {
    if (hands[i].handedness === "Right") rightHandIndex = i;
    else if (hands[i].handedness === "Left") leftHandIndex = i;
  }

  const now = millis();
  if (rightHandIndex !== -1 && previousRightHandIndex === -1) {
    rightHandStableSince = now;
    // 手離開鏡頭後重新出現，不把這次出現誤判成「放開捏合」。
    wasPinching = false;
    isPinching = false;
    holdStartTime = 0;
  } else if (rightHandIndex === -1 && previousRightHandIndex !== -1) {
    resetRightHandAudio();
  }

  if (leftHandIndex !== -1 && previousLeftHandIndex === -1) {
    leftHandStableSince = now;
    currentXyloNote = "";
    lastXyloTrigger = now;
  } else if (leftHandIndex === -1 && previousLeftHandIndex !== -1) {
    resetLeftHandAudio();
  }
  setStatus(hands.length ? `已辨識 ${hands.length} 隻手` : "攝影機已啟動，請將雙手移入鏡頭範圍");
}

function resetRightHandAudio() {
  isPinching = false;
  wasPinching = false;
  holdStartTime = 0;
  blackHoleStrength = 0;
  rightHandStableSince = 0;
  if (handpanSynth) handpanSynth.releaseAll(Tone.now());
}

function resetLeftHandAudio() {
  currentXyloNote = "";
  leftHandStableSince = 0;
  if (xylophoneSynth) xylophoneSynth.releaseAll(Tone.now());
  if (delayEffect) delayEffect.feedback.rampTo(0, 0.08);
}

function resetAudioInteraction() {
  resetRightHandAudio();
  resetLeftHandAudio();
  hands = [];
  rightHandIndex = -1;
  leftHandIndex = -1;
}

function draw() {
  if (!started) return;
  background(10, 10, 30, 50);
  updateHandLogic();

  let yoff = 0;
  for (let y = 0; y < rows; y++) {
    let xoff = 0;
    for (let x = 0; x < cols; x++) {
      const index = x + y * cols;
      const angle = noise(xoff, yoff, zoff) * TWO_PI * 2;
      const vector = flowField[index];
      vector.set(cos(angle), sin(angle));
      vector.mult(0.3);
      xoff += 0.1;
    }
    yoff += 0.1;
  }
  zoff += 0.001;
  drawVisuals();

  let repelRadius = 0;
  if (leftHandIndex !== -1) repelRadius = map(leftHandPos.x, 0, width, 180, 350);
  for (const particle of particles) {
    particle.follow(flowField);
    particle.applyAttraction(rightHandPos.x, rightHandPos.y, blackHoleStrength);
    if (leftHandIndex !== -1) particle.applyRepulsion(leftHandPos.x, leftHandPos.y, repelRadius);
    particle.update();
    particle.show();
  }
  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].update();
    ripples[i].show();
    if (ripples[i].finished()) ripples.splice(i, 1);
  }
}

function updateHandLogic() {
  if (rightHandIndex !== -1 && millis() - rightHandStableSince >= HAND_STABLE_MS) {
    const hand = hands[rightHandIndex];
    const indexTip = hand.keypoints[8];
    const thumbTip = hand.keypoints[4];
    if (!indexTip || !thumbTip || !Number.isFinite(indexTip.x) || !Number.isFinite(indexTip.y) ||
        !Number.isFinite(thumbTip.x) || !Number.isFinite(thumbTip.y)) return;
    rightHandPos.x = lerp(rightHandPos.x, map(indexTip.x, 0, VIDEO_W, 0, width), smoothFactor);
    rightHandPos.y = lerp(rightHandPos.y, map(indexTip.y, 0, VIDEO_H, 0, height), smoothFactor);
    const dx = indexTip.x - thumbTip.x;
    const dy = indexTip.y - thumbTip.y;
    const pinch = dx * dx + dy * dy < PINCH_THRESHOLD * PINCH_THRESHOLD;
    if (pinch && !wasPinching) { isPinching = true; holdStartTime = millis(); }
    else if (!pinch && wasPinching) { isPinching = false; triggerHandpanExplosion(); }
    wasPinching = pinch;
  }
  if (leftHandIndex !== -1 && millis() - leftHandStableSince >= HAND_STABLE_MS) {
    const indexTip = hands[leftHandIndex].keypoints[8];
    if (!indexTip || !Number.isFinite(indexTip.x) || !Number.isFinite(indexTip.y)) return;
    leftHandPos.x = lerp(leftHandPos.x, map(indexTip.x, 0, VIDEO_W, 0, width), smoothFactor);
    leftHandPos.y = lerp(leftHandPos.y, map(indexTip.y, 0, VIDEO_H, 0, height), smoothFactor);
    let noteIndex = constrain(floor(map(leftHandPos.y, height, 0, 0, xyloScale.length)), 0, xyloScale.length - 1);
    const targetNote = xyloScale[noteIndex];
    if (targetNote !== currentXyloNote && millis() - lastXyloTrigger > NOTE_TRIGGER_GAP_MS) {
      xylophoneSynth.triggerAttackRelease(targetNote, "32n", Tone.now() + 0.01, 0.35);
      currentXyloNote = targetNote;
      lastXyloTrigger = millis();
    }
    // 回授量限制在 0.22，避免長時間閒置時延遲訊號累積後突然爆音。
    delayEffect.feedback.rampTo(constrain(map(leftHandPos.x, 0, width, 0, 0.22), 0, 0.22), 0.15);
  }
}

function drawVisuals() {
  noStroke();
  if (rightHandIndex !== -1) {
    if (isPinching) {
      fill(255, 100, 100, 200); ellipse(rightHandPos.x, rightHandPos.y, 20);
      blackHoleStrength = constrain(map(millis() - holdStartTime, 0, 2000, 0.5, 4), 0.5, 4);
      noFill(); stroke(255, 200, 180, 150); strokeWeight(2);
      const visualRadius = blackHoleStrength * 120 + random(-3, 3);
      ellipse(rightHandPos.x, rightHandPos.y, visualRadius);
      stroke(255, 100, 100, 80); ellipse(rightHandPos.x, rightHandPos.y, visualRadius * 0.7);
    } else {
      fill(255, 200, 200, 150); ellipse(rightHandPos.x, rightHandPos.y, 15);
      blackHoleStrength = lerp(blackHoleStrength, 0, 0.15);
    }
  }
  if (leftHandIndex !== -1) {
    fill(100, 255, 220, 200); ellipse(leftHandPos.x, leftHandPos.y, 20);
    const delayAmount = map(leftHandPos.x, 0, width, 0, 3);
    noFill(); stroke(100, 255, 220, 100); strokeWeight(2); ellipse(leftHandPos.x, leftHandPos.y, 60);
    if (delayAmount > 1) ellipse(leftHandPos.x, leftHandPos.y, 80);
    if (delayAmount > 2) ellipse(leftHandPos.x, leftHandPos.y, 100);
    stroke(100, 255, 220, 40); line(0, leftHandPos.y, width, leftHandPos.y);
  }
}

function triggerHandpanExplosion() {
  const now = millis();
  if (!holdStartTime || now - lastExplosionAt < EXPLOSION_COOLDOWN_MS) return;
  const holdTime = constrain(now - holdStartTime, 0, MAX_PINCH_HOLD_MS);
  if (holdTime < 100) return;
  lastExplosionAt = now;
  const power = constrain(map(holdTime, 0, 2000, 5, 15), 5, 15);
  const radius = constrain(map(holdTime, 0, 2000, 150, 350), 150, 350);
  const notes = [random(handpanScale)];
  if (random() > 0.4) notes.push(random(handpanScale));
  handpanSynth.triggerAttackRelease(notes, "1n", Tone.now() + 0.01, map(holdTime, 0, 2000, 0.25, 0.5));
  ripples.push(new Ripple(rightHandPos.x, rightHandPos.y, radius));
  for (const particle of particles) particle.fireworkExplode(createVector(rightHandPos.x, rightHandPos.y), power, radius);
}

class Particle {
  constructor(x, y, first = false) {
    this.pos = createVector(x, y); this.vel = p5.Vector.random2D().mult(0.2); this.acc = createVector(0, 0);
    this.size = random(4, 12); this.color = color(...random(starryColors)); this.exploding = false; this.explodeTimer = 0;
    this.scaleFactor = 1; this.maxLife = random(150, 300); this.age = first ? random(this.maxLife) : 0; this.alpha = first ? 200 : 0;
  }
  respawn() { this.pos.set(random(width), random(height)); this.vel = p5.Vector.random2D().mult(0.2); this.acc.set(0, 0); this.age = 0; this.alpha = 0; this.exploding = false; }
  follow(vectors) { if (!this.exploding) { const x = floor(this.pos.x / scl), y = floor(this.pos.y / scl), i = x + y * cols; if (i >= 0 && i < vectors.length) this.acc.add(vectors[i]); } }
  applyAttraction(tx, ty, strength) { if (this.exploding || strength < 0.1) return; const dx = tx - this.pos.x, dy = ty - this.pos.y, dSq = dx * dx + dy * dy, radius = 450; if (dSq > 0.0001 && dSq < radius * radius) { const d = Math.sqrt(dSq), force = map(d, 0, radius, strength * 1.5, 0); this.acc.add((dx / d) * force, (dy / d) * force); } }
  applyRepulsion(tx, ty, radius) { if (this.exploding) return; const dx = this.pos.x - tx, dy = this.pos.y - ty, dSq = dx * dx + dy * dy; if (dSq > 0.0001 && dSq < radius * radius) { const d = Math.sqrt(dSq), force = map(d, 0, radius, 1.5, 0); this.acc.add((dx / d) * force, (dy / d) * force); } }
  fireworkExplode(origin, power, radius) { if (this.pos.dist(origin) > radius) return; this.exploding = true; this.explodeTimer = 45; this.vel = p5.Vector.sub(this.pos, origin).normalize().mult(random(power * 0.8, power * 1.2)); this.age = 0; this.alpha = 255; }
  update() { if (!this.exploding) { this.age++; if (this.age > this.maxLife) { this.respawn(); return; } if (this.age < 20) this.alpha = map(this.age, 0, 20, 0, 200); else if (this.age > this.maxLife - 30) this.alpha = map(this.age, this.maxLife - 30, this.maxLife, 200, 0); else this.alpha = 200; this.vel.add(this.acc); this.vel.limit(1.2); } else { this.explodeTimer--; this.vel.mult(0.94); if (this.explodeTimer <= 0) this.exploding = false; } this.pos.add(this.vel); this.acc.set(0, 0); if (this.pos.x < -20) this.pos.x = width + 20; if (this.pos.x > width + 20) this.pos.x = -20; if (this.pos.y < -20) this.pos.y = height + 20; if (this.pos.y > height + 20) this.pos.y = -20; }
  show() { strokeWeight(this.size * (this.exploding ? this.scaleFactor : 1)); stroke(red(this.color), green(this.color), blue(this.color), this.alpha); point(this.pos.x, this.pos.y); }
}

class Ripple {
  constructor(x, y, radius) { this.x = x; this.y = y; this.r = 0; this.alpha = 255; this.maxRadius = radius; }
  update() { this.r += 12; this.alpha -= 8; }
  show() { noFill(); stroke(200, 200, 255, this.alpha); strokeWeight(3); ellipse(this.x, this.y, this.r); }
  finished() { return this.alpha <= 0; }
}

function keyPressed() {
  if (key === "f" || key === "F") fullscreen(!fullscreen());
  if (key === "Escape") fullscreen(false);
}

function initFlowField() {
  cols = floor(width / scl) + 1;
  rows = floor(height / scl) + 1;
  flowField = new Array(cols * rows);
  for (let i = 0; i < flowField.length; i++) flowField[i] = createVector(0, 0);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  initFlowField();
}
