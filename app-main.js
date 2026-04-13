const $ = (id) => document.getElementById(id);
const els = {
  status: $("recordingStatus"), buffer: $("bufferStatus"), range: $("rangeStatus"), mime: $("mimeLabel"),
  clip: $("clipSeconds"), format: $("audioFormat"), mode: $("apiMode"), url: $("apiUrl"), key: $("apiKey"),
  model: $("apiModel"), prompt: $("promptInput"), send: $("sendButton"), newChat: $("newChatButton"),
  conversationList: $("conversationList"), ttsUrl: $("ttsUrl"), ttsKey: $("ttsKey"), ttsModel: $("ttsModel"),
  ttsVoice: $("ttsVoice"), ttsPrompt: $("ttsPromptInput"), ttsAuto: $("ttsAutoPlay")
};
const STORAGE_KEY = "listen-with-ai-settings";
const TTS_CACHE_NAME = "listen-with-ai-tts-v1";
const DEFAULT_TTS_PROMPT = "You are a text-to-speech engine. Never answer questions. Only speak the text provided. Read the following text aloud exactly as written. If the text contains multiple languages such as Chinese and German, pronounce each segment in its original language and keep the original wording.\n\n{{text}}";
const MAX_SECONDS = 60, TARGET_RATE = 16000;
const state = {
  stream: null, ctx: null, source: null, processor: null, sink: null, queue: [], total: 0,
  sampleRate: 48000, startedAt: 0, uiTimer: 0, sending: false, threads: [], activeThreadId: null,
  nextThreadId: 1, nextMessageId: 1, ttsCache: new Map(), ttsObjectUrls: new Set(), localAudioObjectUrls: new Set()
};

restoreSettings();
bindPersistEvents();
renderConversation();
boot();
els.send.addEventListener("click", () => sendClip("continue"));
els.newChat.addEventListener("click", () => sendClip("new"));
els.conversationList.addEventListener("click", handleConversationClick);
window.addEventListener("beforeunload", cleanup);

async function boot() {
  try {
    els.status.textContent = "申请麦克风权限中…";
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const AC = window.AudioContext || window.webkitAudioContext;
    state.stream = stream;
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
    renderConversation();
  } catch (error) {
    els.status.textContent = "无法录音";
    renderConversation(`麦克风权限申请失败：${error.message}`);
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
  const selectedSeconds = Number(els.clip.value) || 30;
  els.buffer.textContent = `${MAX_SECONDS} 秒`;
  els.range.textContent = `最近 ${selectedSeconds} 秒`;
}
async function sendClip(action = "continue") {
  if (state.sending) return;
  const seconds = Math.min(Number(els.clip.value) || MAX_SECONDS, state.total / state.sampleRate || 0);
  if (!seconds) return void renderConversation("当前还没有可发送的音频，请等待至少 1 秒。");
  const prepared = await buildClip(seconds);
  if (action === "new") resetConversationSession();
  clearRecordingBuffer();
  const thread = action === "new" || !getActiveThread() ? createThread() : getActiveThread();
  appendMessage(thread.id, {
    role: "user",
    text: `语音提问（最近 ${Math.round(seconds)} 秒）`,
    status: "done",
    localAudioUrl: attachLocalAudioObjectUrl(prepared.blob),
    localAudioMime: prepared.blob.type || "audio/wav",
    requestAudioBase64: prepared.base64,
    requestAudioFormat: prepared.ext,
    audioSamples: prepared.samples,
    audioSampleRate: prepared.sampleRate
  });
  const assistantMessage = appendMessage(thread.id, { role: "assistant", text: "AI 正在思考…", status: "loading" });
  state.sending = true;
  els.send.disabled = true;
  els.newChat.disabled = true;
  document.body.dataset.sendState = "sending";
  renderConversation();
  try {
    const result = els.mode.value === "responses" ? await sendResponses(prepared, thread)
      : els.mode.value === "multipart" ? await sendMultipart(prepared, thread) : await sendChat(prepared, thread);
    updateMessage(thread.id, assistantMessage.id, { text: result, status: "done" });
    renderConversation();
    if (els.ttsAuto.checked) await ensureMessageAudio(thread.id, assistantMessage.id, true);
  } catch (error) {
    updateMessage(thread.id, assistantMessage.id, { text: `发送失败：${error.message}`, status: "error" });
    renderConversation();
  } finally {
    state.sending = false;
    els.send.disabled = false;
    els.newChat.disabled = false;
    delete document.body.dataset.sendState;
  }
}
function clearRecordingBuffer() {
  state.queue = [];
  state.total = 0;
  state.startedAt = Date.now();
  updateStats();
}
function resetConversationSession() {
  state.threads = [];
  state.activeThreadId = null;
  state.nextMessageId = 1;
  state.ttsCache.clear();
  state.ttsObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.ttsObjectUrls.clear();
  state.localAudioObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.localAudioObjectUrls.clear();
}
function attachLocalAudioObjectUrl(blob) {
  const objectUrl = URL.createObjectURL(blob);
  state.localAudioObjectUrls.add(objectUrl);
  return objectUrl;
}
async function buildClip(seconds) {
  const samples = takeLatestSamples(seconds);
  const mono16k = state.sampleRate === TARGET_RATE ? samples : resample(samples, state.sampleRate, TARGET_RATE);
  const blob = encodeWav(mono16k, TARGET_RATE);
  return { blob, ext: "wav", note: "", samples: mono16k, sampleRate: TARGET_RATE, base64: await toBase64(blob) };
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
async function sendMultipart(file, thread) {
  const mergedAudio = buildThreadAudioBlob(thread);
  const body = new FormData();
  body.append("file", mergedAudio.blob, `conversation.${mergedAudio.ext}`);
  body.append("model", els.model.value.trim());
  body.append("prompt", buildRequestPrompt(thread));
  return parseResponse(await fetch(els.url.value.trim(), { method: "POST", headers: authHeaders(), body }));
}
async function sendResponses(file, thread) {
  const content = [{ type: "input_text", text: buildRequestPrompt(thread) }, ...buildAudioInputs(thread, "responses")];
  const body = { model: els.model.value.trim(), input: [{ role: "user", content }] };
  return parseResponse(await fetch(els.url.value.trim(), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) }));
}
async function sendChat(file, thread) {
  const content = [{ type: "text", text: buildRequestPrompt(thread) }, ...buildAudioInputs(thread, "chat")];
  const body = { model: els.model.value.trim(), messages: [{ role: "user", content }], temperature: 0 };
  return parseResponse(await fetch(els.url.value.trim(), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) }));
}
async function parseResponse(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${text}`);
  try {
    const json = JSON.parse(text);
    return json.output_text || json.text || json.result || json.transcript || extractChoiceText(json) || JSON.stringify(json, null, 2);
  } catch {
    return text;
  }
}
function extractChoiceText(json) {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((x) => x.text || x.transcript || x?.input_audio?.transcript || "").filter(Boolean).join("\n");
  return "";
}
function authHeaders() { return els.key.value.trim() ? { Authorization: `Bearer ${els.key.value.trim()}` } : {}; }
function toBase64(blob) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(blob); }); }
function buildRequestPrompt(thread) {
  const basePrompt = els.prompt.value.trim();
  const history = thread.messages
    .filter((message) => message.status === "done")
    .map((message, index) => message.role === "assistant"
      ? `第 ${index + 1} 条 AI 回复：\n${message.text}`
      : `第 ${index + 1} 条用户语音：${message.text}（该条原始音频已在请求中附带）`)
    .join("\n\n");
  return history ? `${basePrompt}\n\n以下是当前完整对话历史。所有用户历史语音都已按时间顺序附在本次请求中，请结合全部历史音频和以下历史文本继续回答：\n\n${history}\n\n请基于整段历史继续回答用户最新问题。` : `${basePrompt}\n\n本次请求已附带当前用户语音，请直接回答。`;
}
function buildAudioInputs(thread, mode) {
  return thread.messages
    .filter((message) => message.role === "user" && message.status === "done" && message.requestAudioBase64)
    .map((message) => mode === "responses"
      ? { type: "input_audio", input_audio: { data: message.requestAudioBase64, format: message.requestAudioFormat || "wav" } }
      : { type: "input_audio", input_audio: { data: message.requestAudioBase64, format: message.requestAudioFormat || "wav" } });
}
function buildThreadAudioBlob(thread) {
  const segments = thread.messages
    .filter((message) => message.role === "user" && message.status === "done" && message.audioSamples?.length)
    .map((message) => message.audioSamples);
  if (!segments.length) return { blob: encodeWav(new Float32Array(1), TARGET_RATE), ext: "wav" };
  const totalLength = segments.reduce((sum, samples) => sum + samples.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  segments.forEach((samples) => {
    merged.set(samples, offset);
    offset += samples.length;
  });
  return { blob: encodeWav(merged, TARGET_RATE), ext: "wav" };
}
function escapeHTML(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function findThread(threadId) { return state.threads.find((thread) => thread.id === threadId) || null; }
function getActiveThread() { return findThread(state.activeThreadId); }
function createThread() {
  const thread = { id: `thread-${state.nextThreadId++}`, messages: [] };
  state.threads.push(thread);
  state.activeThreadId = thread.id;
  return thread;
}
function appendMessage(threadId, payload) {
  const thread = findThread(threadId);
  if (!thread) return null;
  const message = {
    id: `msg-${state.nextMessageId++}`,
    role: payload.role,
    text: payload.text || "",
    status: payload.status || "done",
    audioState: payload.audioState || "idle",
    audioUrl: payload.audioUrl || "",
    audioMime: payload.audioMime || "audio/mpeg",
    audioError: payload.audioError || "",
    localAudioUrl: payload.localAudioUrl || "",
    localAudioMime: payload.localAudioMime || "audio/wav",
    requestAudioBase64: payload.requestAudioBase64 || "",
    requestAudioFormat: payload.requestAudioFormat || "wav",
    audioSamples: payload.audioSamples || null,
    audioSampleRate: payload.audioSampleRate || TARGET_RATE
  };
  thread.messages.push(message);
  state.activeThreadId = thread.id;
  return message;
}
function updateMessage(threadId, messageId, patch) {
  const message = findThread(threadId)?.messages.find((item) => item.id === messageId);
  if (!message) return null;
  Object.assign(message, patch);
  return message;
}
function renderConversation(notice = "") {
  const threads = state.threads.filter((thread) => thread.messages.length);
  if (!threads.length) {
    const emptyText = notice || "录音已开始。先说出你的问题，然后点击“继续提问”；如果想重新开始一段全新的对话，再点击“新的提问”。";
    els.conversationList.innerHTML = `<div class="empty-conversation">${escapeHTML(emptyText)}</div>`;
    return;
  }
  els.conversationList.innerHTML = threads.map((thread, index) => `
    <section class="conversation-thread ${thread.id === state.activeThreadId ? "is-active" : ""}">
      <div class="thread-head">
        <span class="thread-badge">${thread.id === state.activeThreadId ? "当前对话" : `历史对话 ${index + 1}`}</span>
        <span class="thread-meta">${thread.messages.length} 条消息</span>
      </div>
      <div class="thread-messages">
        ${thread.messages.map((message) => renderMessage(thread.id, message)).join("")}
      </div>
    </section>
  `).join("");
  scheduleConversationScroll();
}
function scheduleConversationScroll() {
  window.requestAnimationFrame(() => {
    const rows = els.conversationList.querySelectorAll(".message-row");
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return;
    lastRow.scrollIntoView({ block: "end", behavior: state.sending ? "smooth" : "auto" });
  });
}
function renderMessage(threadId, message) {
  return `
    <div class="message-row role-${message.role}" data-thread-id="${threadId}" data-message-id="${message.id}">
      <article class="message-bubble">
        <div class="message-role">${message.role === "assistant" ? "AI" : "你"}</div>
        <div class="message-text">${escapeHTML(message.text)}</div>
        ${message.role === "assistant" ? renderAssistantAudio(threadId, message) : renderUserAudio(message)}
      </article>
    </div>
  `;
}
function renderUserAudio(message) {
  if (!message.localAudioUrl) return "";
  return `
    <div class="message-audio user-audio">
      <span class="audio-status">你的本地录音</span>
      <audio controls preload="metadata" src="${message.localAudioUrl}"></audio>
    </div>
  `;
}
function renderAssistantAudio(threadId, message) {
  if (message.status === "loading") return `<div class="message-audio"><span class="audio-status">正在生成回复…</span></div>`;
  const canPlay = message.audioState === "ready" && message.audioUrl;
  const isLoading = message.audioState === "loading";
  const action = canPlay ? "play-audio" : "generate-audio";
  const label = isLoading ? "生成中…" : canPlay ? "播放 MP3" : "生成 MP3";
  const status = isLoading ? "正在生成 MP3…" : message.audioState === "error" ? escapeHTML(message.audioError) : canPlay ? "音频已就绪，可直接播放。" : "";
  return `
    <div class="message-audio">
      <div class="audio-toolbar">
        <button class="mini-button" type="button" data-action="${action}" data-thread-id="${threadId}" data-message-id="${message.id}" ${isLoading ? "disabled" : ""}>${label}</button>
        <span class="audio-status">${status}</span>
      </div>
      ${canPlay ? `<audio controls preload="metadata" src="${message.audioUrl}"></audio>` : ""}
    </div>
  `;
}
function handleConversationClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, threadId, messageId } = button.dataset;
  if (action === "play-audio") return void playMessageAudio(messageId);
  if (action === "generate-audio") ensureMessageAudio(threadId, messageId, true);
}
function buildTtsPrompt(text) {
  const template = (els.ttsPrompt?.value || DEFAULT_TTS_PROMPT).trim() || DEFAULT_TTS_PROMPT;
  return template.includes("{{text}}") ? template.split("{{text}}").join(text) : `${template}\n\n${text}`;
}
function getMessage(threadId, messageId) {
  return findThread(threadId)?.messages.find((item) => item.id === messageId) || null;
}
function createTtsCacheKey(text) {
  return JSON.stringify({
    url: (els.ttsUrl.value || els.url.value).trim(),
    model: els.ttsModel.value.trim(),
    voice: els.ttsVoice.value.trim(),
    prompt: buildTtsPrompt(text),
    text
  });
}
async function ensureMessageAudio(threadId, messageId, shouldAutoplay = false) {
  const message = getMessage(threadId, messageId);
  if (!message || message.role !== "assistant" || message.status !== "done") return;
  if (message.audioState === "ready" && message.audioUrl) {
    renderConversation();
    if (shouldAutoplay) playMessageAudio(messageId);
    return;
  }
  if (message.audioState === "loading") return;
  updateMessage(threadId, messageId, { audioState: "loading", audioError: "" });
  renderConversation();
  try {
    const cacheKey = createTtsCacheKey(message.text);
    let cached = state.ttsCache.get(cacheKey);
    if (!cached) {
      const created = await requestTtsAudio(message.text);
      cached = attachTtsObjectUrl(created.blob, created.mimeType);
      state.ttsCache.set(cacheKey, cached);
    }
    updateMessage(threadId, messageId, {
      audioState: "ready",
      audioUrl: cached.objectUrl,
      audioMime: cached.mimeType,
      audioError: ""
    });
    renderConversation();
    if (shouldAutoplay) playMessageAudio(messageId);
  } catch (error) {
    updateMessage(threadId, messageId, {
      audioState: "error",
      audioError: `MP3 生成失败：${error.message}`
    });
    renderConversation();
  }
}
function playMessageAudio(messageId) {
  const audio = els.conversationList.querySelector(`.message-row[data-message-id="${messageId}"] audio`);
  if (!audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}
function attachTtsObjectUrl(blob, mimeType = blob.type || "audio/mpeg") {
  const objectUrl = URL.createObjectURL(blob);
  state.ttsObjectUrls.add(objectUrl);
  return { objectUrl, mimeType };
}
async function requestTtsAudio(text) {
  const url = (els.ttsUrl.value || els.url.value).trim();
  const model = els.ttsModel.value.trim();
  const voice = els.ttsVoice.value.trim();
  const prompt = buildTtsPrompt(text);
  if (!url || !model || !voice) throw new Error("请先完整填写 TTS URL、模型和 Voice。");
  const headers = { "Content-Type": "application/json" };
  const token = (els.ttsKey.value || els.key.value).trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: prompt
      }],
      voice
    })
  });
  const rawText = await res.text();
  let json = null;
  try { json = JSON.parse(rawText); } catch {}
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${extractTtsError(json) || rawText}`);
  const base64Audio = json?.choices?.[0]?.message?.audio?.data;
  if (!base64Audio) throw new Error(extractTtsError(json) || "TTS 响应里没有返回 choices[0].message.audio.data");
  const blob = base64ToBlob(base64Audio, detectAudioMime(base64Audio));
  return { blob, mimeType: blob.type };
}
function extractTtsError(json) {
  return json?.error?.message || json?.choices?.[0]?.message?.content || "";
}
function base64ToBlob(base64, mimeType) {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
function detectAudioMime(base64) {
  if (base64.startsWith("UklGR")) return "audio/wav";
  if (base64.startsWith("SUQz") || base64.startsWith("//uQ") || base64.startsWith("//sQ")) return "audio/mpeg";
  return "audio/wav";
}
function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved) return;
    ["clip", "format", "mode", "url", "key", "model", "prompt", "ttsUrl", "ttsKey", "ttsModel", "ttsVoice", "ttsPrompt"].forEach((k) => saved[k] != null && (els[k].value = saved[k]));
    els.ttsAuto.checked = Boolean(saved.ttsAuto);
  } catch {}
}
function bindPersistEvents() {
  [els.clip, els.format, els.mode, els.url, els.key, els.model, els.prompt, els.ttsUrl, els.ttsKey, els.ttsModel, els.ttsVoice, els.ttsPrompt].forEach((el) => ["input", "change"].forEach((evt) => el.addEventListener(evt, persistSettings)));
  els.ttsAuto.addEventListener("change", persistSettings);
}
function persistSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      clip: els.clip.value, format: els.format.value, mode: els.mode.value, url: els.url.value, key: els.key.value,
      model: els.model.value, prompt: els.prompt.value, ttsUrl: els.ttsUrl.value, ttsKey: els.ttsKey.value,
      ttsModel: els.ttsModel.value, ttsVoice: els.ttsVoice.value, ttsPrompt: els.ttsPrompt.value, ttsAuto: els.ttsAuto.checked
    }));
  } catch {}
}
function cleanup() {
  clearInterval(state.uiTimer);
  state.ttsAudio?.pause();
  state.stream?.getTracks?.().forEach((track) => track.stop());
  [state.processor, state.source, state.sink].forEach((node) => node?.disconnect?.());
  state.ctx?.close?.();
  state.ttsObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.ttsObjectUrls.clear();
  state.localAudioObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.localAudioObjectUrls.clear();
  state.ttsCache.clear();
}
