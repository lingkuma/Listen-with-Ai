const $ = (id) => document.getElementById(id);
const els = {
  status: $("recordingStatus"), buffer: $("bufferStatus"), cycle: $("cycleStatus"), mime: $("mimeLabel"),
  clip: $("clipSeconds"), format: $("audioFormat"), mode: $("apiMode"), url: $("apiUrl"), key: $("apiKey"),
  model: $("apiModel"), prompt: $("promptInput"), output: $("resultOutput"), send: $("sendButton")
};
const STORAGE_KEY = "listen-with-ai-settings";
const MAX_SECONDS = 20, TARGET_RATE = 16000;
const state = { stream: null, ctx: null, source: null, processor: null, sink: null, queue: [], total: 0, sampleRate: 48000, startedAt: 0, uiTimer: 0, sending: false };

restoreSettings();
bindPersistEvents();
boot();
els.send.addEventListener("click", sendClip);
window.addEventListener("beforeunload", cleanup);

async function boot() {
  try {
    els.status.textContent = "申请麦克风权限中…";
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const AC = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AC();
    await state.ctx.resume();
    state.sampleRate = state.ctx.sampleRate;
    state.source = state.ctx.createMediaStreamSource(stream);
    state.processor = state.ctx.createScriptProcessor(4096, 1, 1);
    state.sink = state.ctx.createGain();
    state.sink.gain.value = 0;
    state.processor.onaudioprocess = (e) => pushChunk(e.inputBuffer.getChannelData(0));
    state.source.connect(state.processor);
    state.processor.connect(state.sink);
    state.sink.connect(state.ctx.destination);
    state.startedAt = Date.now();
    state.uiTimer = window.setInterval(updateStats, 250);
    els.status.textContent = "录音中（PCM 环形缓冲已启动）";
    els.mime.textContent = "缓存引擎：PCM / 上传格式：WAV";
    updateStats();
  } catch (error) {
    els.status.textContent = "无法录音";
    els.output.textContent = `麦克风权限申请失败：${error.message}`;
  }
}
function pushChunk(input) {
  const chunk = new Float32Array(input);
  state.queue.push(chunk);
  state.total += chunk.length;
  const limit = Math.ceil(MAX_SECONDS * state.sampleRate);
  while (state.total > limit && state.queue.length) {
    const over = state.total - limit, first = state.queue[0];
    if (over >= first.length) { state.queue.shift(); state.total -= first.length; }
    else { state.queue[0] = first.slice(over); state.total -= over; }
  }
}
function updateStats() {
  const buffered = Math.min(MAX_SECONDS, state.total / state.sampleRate || 0);
  const cycle = Math.floor(((Date.now() - state.startedAt) / 1000) / MAX_SECONDS) + 1;
  els.buffer.textContent = `${buffered.toFixed(1)} / ${MAX_SECONDS} 秒`;
  els.cycle.textContent = `第 ${cycle} 轮 / 20 秒窗口`;
}
async function sendClip() {
  if (state.sending) return;
  const seconds = Math.min(Number(els.clip.value) || MAX_SECONDS, state.total / state.sampleRate || 0);
  if (!seconds) return void (els.output.textContent = "当前还没有可发送的音频，请等待至少 1 秒。");
  state.sending = true; els.send.disabled = true; els.output.textContent = "正在导出最近音频并发送给 AI…";
  try {
    const prepared = await buildClip(seconds);
    const result = els.mode.value === "responses" ? await sendResponses(prepared)
      : els.mode.value === "multipart" ? await sendMultipart(prepared) : await sendChat(prepared);
    els.output.textContent = `${prepared.note ? `${prepared.note}\n\n` : ""}${result}`;
  } catch (error) {
    els.output.textContent = `发送失败：${error.message}`;
  } finally {
    state.sending = false; els.send.disabled = false;
  }
}
async function buildClip(seconds) {
  const samples = takeLatestSamples(seconds);
  const mono16k = state.sampleRate === TARGET_RATE ? samples : resample(samples, state.sampleRate, TARGET_RATE);
  return { blob: encodeWav(mono16k, TARGET_RATE), ext: "wav", note: els.format.value === "wav" ? "" : "为避免分段拼接失效，当前统一导出 WAV 上传。" };
}
function takeLatestSamples(seconds) {
  const need = Math.min(state.total, Math.floor(seconds * state.sampleRate));
  const out = new Float32Array(need); let offset = need;
  for (let i = state.queue.length - 1; i >= 0 && offset > 0; i -= 1) {
    const chunk = state.queue[i], size = Math.min(chunk.length, offset);
    offset -= size; out.set(chunk.subarray(chunk.length - size), offset);
  }
  return out;
}
function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to, out = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0, count = 0; for (let j = start; j < end; j += 1) { sum += input[j]; count += 1; }
    out[i] = count ? sum / count : input[start] || 0;
  }
  return out;
}
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const write = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0, p = 44; i < samples.length; i += 1, p += 2) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buffer], { type: "audio/wav" });
}
async function sendMultipart(file) { const body = new FormData(); body.append("file", file.blob, `clip.${file.ext}`); body.append("model", els.model.value.trim()); body.append("prompt", els.prompt.value.trim()); return parseResponse(await fetch(els.url.value.trim(), { method: "POST", headers: authHeaders(), body })); }
async function sendResponses(file) { const body = { model: els.model.value.trim(), input: [{ role: "user", content: [{ type: "input_text", text: els.prompt.value.trim() }, { type: "input_audio", input_audio: { data: await toBase64(file.blob), format: file.ext } }] }] }; return parseResponse(await fetch(els.url.value.trim(), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) })); }
async function sendChat(file) { const body = { model: els.model.value.trim(), messages: [{ role: "user", content: [{ type: "text", text: els.prompt.value.trim() }, { type: "input_audio", input_audio: { data: await toBase64(file.blob), format: file.ext } }] }], temperature: 0 }; return parseResponse(await fetch(els.url.value.trim(), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) })); }
async function parseResponse(res) { const text = await res.text(); if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${text}`); try { const json = JSON.parse(text); return json.output_text || json.text || json.result || json.transcript || extractChoiceText(json) || JSON.stringify(json, null, 2); } catch { return text; } }
function extractChoiceText(json) { const content = json.choices?.[0]?.message?.content; if (typeof content === "string") return content; if (Array.isArray(content)) return content.map((x) => x.text || x.transcript || x?.input_audio?.transcript || "").filter(Boolean).join("\n"); return ""; }
function authHeaders() { return els.key.value.trim() ? { Authorization: `Bearer ${els.key.value.trim()}` } : {}; }
function toBase64(blob) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(blob); }); }
function restoreSettings() { try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); if (!saved) return; ["clip", "format", "mode", "url", "key", "model", "prompt"].forEach((k) => saved[k] != null && (els[k].value = saved[k])); } catch {} }
function bindPersistEvents() { [els.clip, els.format, els.mode, els.url, els.key, els.model, els.prompt].forEach((el) => ["input", "change"].forEach((evt) => el.addEventListener(evt, persistSettings))); }
function persistSettings() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ clip: els.clip.value, format: els.format.value, mode: els.mode.value, url: els.url.value, key: els.key.value, model: els.model.value, prompt: els.prompt.value })); } catch {} }
function cleanup() { clearInterval(state.uiTimer); [state.processor, state.source, state.sink].forEach((node) => node?.disconnect?.()); state.ctx?.close?.(); }
