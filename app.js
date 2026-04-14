const $ = (id) => document.getElementById(id);
const els = {
  status: $("recordingStatus"), buffer: $("bufferStatus"), cycle: $("cycleStatus"), mime: $("mimeLabel"),
  clip: $("clipSeconds"), format: $("audioFormat"), mode: $("apiMode"), url: $("apiUrl"), key: $("apiKey"),
  model: $("apiModel"), prompt: $("promptInput"), output: $("resultOutput"), send: $("sendButton")
};
const state = { stream: null, recorder: null, ring: [], cycle: 0, timer: 0, mime: "audio/webm", sending: false };
const STORAGE_KEY = "listen-with-ai-settings";
const MAX_SECONDS = 20, CHUNK_MS = 1000, CYCLE_MS = 20000;

restoreSettings();
bindPersistEvents();
boot();
els.send.addEventListener("click", sendClip);
window.addEventListener("beforeunload", () => cleanup());

async function boot() {
  try {
    els.status.textContent = "申请麦克风权限中…";
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    startCycle();
  } catch (error) {
    els.status.textContent = "无法录音";
    els.output.textContent = `麦克风权限申请失败：${error.message}`;
  }
}
function startCycle() {
  cleanupRecorder();
  const mime = pickMime();
  state.recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
  state.mime = state.recorder.mimeType || mime || "audio/webm";
  state.cycle += 1;
  els.status.textContent = "录音中（页面加载后已自动开始）";
  els.cycle.textContent = `第 ${state.cycle} 轮 / 20 秒循环`;
  els.mime.textContent = `录制格式：${state.mime}`;
  state.recorder.ondataavailable = ({ data }) => {
    if (!data?.size) return;
    state.ring.push(data);
    while (state.ring.length > MAX_SECONDS) state.ring.shift();
    els.buffer.textContent = `${state.ring.length} / ${MAX_SECONDS} 秒`;
  };
  state.recorder.onstop = () => state.stream?.active && setTimeout(startCycle, 120);
  state.recorder.onerror = (e) => { els.status.textContent = "录音异常"; els.output.textContent = e.error?.message || "MediaRecorder error"; };
  state.recorder.start(CHUNK_MS);
  state.timer = window.setTimeout(() => state.recorder?.state === "recording" && state.recorder.stop(), CYCLE_MS);
}
function pickMime() {
  const wants = els.format.value === "mp3" ? ["audio/mpeg", "audio/webm;codecs=opus", "audio/webm"]
    : els.format.value === "wav" ? ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return wants.find((item) => MediaRecorder.isTypeSupported(item)) || "";
}
async function sendClip() {
  if (state.sending) return;
  const seconds = Math.min(Number(els.clip.value) || MAX_SECONDS, state.ring.length);
  if (!seconds) return void (els.output.textContent = "当前还没有可发送的音频，请等待至少 1 秒。");
  state.sending = true; els.send.disabled = true; els.output.textContent = "正在整理音频并发送给 AI…";
  try {
    const rawBlob = new Blob(state.ring.slice(-seconds), { type: state.mime });
    const prepared = await prepareBlob(rawBlob, els.format.value);
    const result = els.mode.value === "responses" ? await sendResponses(prepared)
      : els.mode.value === "multipart" ? await sendMultipart(prepared)
      : await sendChat(prepared);
    els.output.textContent = `${prepared.note ? `${prepared.note}\n\n` : ""}${result}`;
  } catch (error) {
    els.output.textContent = `发送失败：${error.message}`;
  } finally {
    state.sending = false; els.send.disabled = false;
  }
}
async function sendMultipart(file) {
  const body = new FormData();
  body.append("file", file.blob, `clip.${file.ext}`);
  body.append("model", els.model.value.trim());
  body.append("prompt", els.prompt.value.trim());
  const res = await fetch(els.url.value.trim(), { method: "POST", headers: authHeaders(), body });
  return parseResponse(res);
}
async function sendResponses(file) {
  const base64 = await blobToBase64(file.blob);
  const body = {
    model: els.model.value.trim(),
    input: [{ role: "user", content: [
      { type: "input_text", text: els.prompt.value.trim() },
      { type: "input_audio", input_audio: { data: base64, format: file.ext } }
    ] }]
  };
  const res = await fetch(els.url.value.trim(), {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body)
  });
  return parseResponse(res);
}
async function sendChat(file) {
  const base64 = await blobToBase64(file.blob);
  const body = {
    model: els.model.value.trim(),
    messages: [{ role: "user", content: [
      { type: "text", text: els.prompt.value.trim() },
      { type: "input_audio", input_audio: { data: base64, format: file.ext } }
    ] }],
    temperature: 0
  };
  const res = await fetch(els.url.value.trim(), {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body)
  });
  return parseResponse(res);
}
async function parseResponse(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${text}`);
  try {
    const json = JSON.parse(text);
    return json.output_text || json.text || json.result || json.transcript || extractChoiceText(json) || JSON.stringify(json, null, 2);
  } catch { return text; }
}
function extractChoiceText(json) {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text || item.transcript || item?.input_audio?.transcript || "").filter(Boolean).join("\n");
  return "";
}
async function prepareBlob(blob, format) {
  if (format === "wav") return { blob: await toWav(blob), ext: "wav", note: "已转为 WAV 再发送。" };
  if (format === "mp3" && !blob.type.includes("mpeg")) return { blob, ext: "webm", note: "当前浏览器无法原生编码 MP3，已自动回退为 WebM 发送。" };
  return { blob, ext: format === "mp3" ? "mp3" : "webm", note: "" };
}
async function toWav(blob) {
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = audio.numberOfChannels, len = audio.length * ch * 2, out = new ArrayBuffer(44 + len), view = new DataView(out);
    let off = 0, pos = 44; const write = (s) => [...s].forEach((c) => view.setUint8(off++, c.charCodeAt(0))); const set16 = (v) => (view.setUint16(off, v, true), off += 2); const set32 = (v) => (view.setUint32(off, v, true), off += 4);
    write("RIFF"); set32(36 + len); write("WAVEfmt "); set32(16); set16(1); set16(ch); set32(audio.sampleRate); set32(audio.sampleRate * ch * 2); set16(ch * 2); set16(16); write("data"); set32(len);
    const data = Array.from({ length: ch }, (_, i) => audio.getChannelData(i));
    for (let i = 0; i < audio.length; i += 1) for (let c = 0; c < ch; c += 1) { const s = Math.max(-1, Math.min(1, data[c][i])); view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true); pos += 2; }
    return new Blob([out], { type: "audio/wav" });
  } finally { await ctx.close(); }
}
function authHeaders() { return els.key.value.trim() ? { Authorization: `Bearer ${els.key.value.trim()}` } : {}; }
function blobToBase64(blob) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(blob); }); }
function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved) return;
    ["clip", "format", "mode", "url", "key", "model", "prompt"].forEach((name) => {
      if (saved[name] != null) els[name].value = saved[name];
    });
  } catch {}
}
function bindPersistEvents() {
  [els.format, els.mode, els.url, els.key, els.model, els.prompt].forEach((el) => {
    el.addEventListener("input", persistSettings);
    el.addEventListener("change", persistSettings);
  });
  els.clip.addEventListener("change", persistSettings);
}
function persistSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      clip: els.clip.value, format: els.format.value, mode: els.mode.value, url: els.url.value,
      key: els.key.value, model: els.model.value, prompt: els.prompt.value
    }));
  } catch {}
}
function cleanupRecorder() { clearTimeout(state.timer); if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop(); }
function cleanup() { cleanupRecorder(); state.stream?.getTracks().forEach((t) => t.stop()); }
