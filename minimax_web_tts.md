# MiniMax TTS 普通网页接入

这份文档只保留普通网页最需要的内容：请求代码、请求体、返回解析、播放代码。

## 现成文件

- JS 模块：`docs/public/minimax-web-tts.js`
- 可直接打开的示例页：`docs/public/minimax-web-tts-demo.html`

## 最核心的请求代码

```js
const endpoint = `https://api.minimaxi.chat/v1/t2a_v2?GroupId=${groupId}`;
const body = {
  model: 'speech-01-turbo',
  text: 'Hello MiniMax',
  stream: true,
  language_boost: 'English',
  voice_setting: {
    voice_id: 'English_Graceful_Lady',
    speed: 1.0,
    vol: 1,
    pitch: 0,
    emotio: 'neutral'
  },
  audio_setting: {
    sample_rate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1
  }
};

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(body)
});
```

## 返回怎么处理

仓库里的 MiniMax 播放实验是流式处理：

1. `response.body.getReader()` 读取流
2. `TextDecoder` 解码文本
3. 按 `\n\n` 切分 SSE 数据块
4. 去掉每块前面的 `data:`
5. `JSON.parse(...)`
6. 从 `json.data.audio` 中拿到十六进制音频块
7. **把所有 `audio` 分片按顺序拼起来**
8. 转成 `Uint8Array`
9. 通过 `MediaSource + SourceBuffer(audio/mpeg)` 边下边播

### 非常重要：不要只读最后一个包

MiniMax 的流式返回通常不是一个完整 JSON，而是一串 SSE：

```txt
data: {"data": {"audio": "4944330400000", "status": 2}}

data: {"data": {"status": 2}}
```

这里要注意：

- 第一段里有 `data.audio`，这是音频十六进制分片
- 最后一段可能 **只有 `status`，没有 `audio`**
- 所以不能写成“只取最后一个 JSON 的 `data.audio`”
- 正确做法是：**遍历所有 SSE 包，把每个包里的 `data.audio` 收集起来，再 `join('')`**

也就是说，下面这种逻辑是错的：

```js
const json = JSON.parse(fullText);
const hexAudio = json.data.audio;
```

因为流式场景下 `fullText` 往往根本不是单个 JSON，而是多段 `data: ...`。

## 最小播放代码

```js
const reader = response.body.getReader();
const decoder = new TextDecoder();
const audio = new Audio();
const mediaSource = new MediaSource();
let sourceBuffer;
let pending = [];
let buffer = '';

audio.src = URL.createObjectURL(mediaSource);
await new Promise((resolve) => {
  mediaSource.addEventListener('sourceopen', () => {
    sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
    sourceBuffer.addEventListener('updateend', () => {
      if (pending.length > 0 && !sourceBuffer.updating) {
        sourceBuffer.appendBuffer(pending.shift());
      }
    });
    resolve();
  }, { once: true });
});

function appendHexChunk(hexString) {
  const bytes = new Uint8Array(hexString.match(/.{1,2}/g).map(x => parseInt(x, 16))).buffer;
  if (sourceBuffer.updating || pending.length > 0) pending.push(bytes);
  else sourceBuffer.appendBuffer(bytes);
}

const allHexChunks = [];
let started = false;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  while (true) {
    const endIndex = buffer.indexOf('\n\n');
    if (endIndex === -1) break;
    const chunk = buffer.slice(0, endIndex).trim();
    buffer = buffer.slice(endIndex + 2);
    if (!chunk.startsWith('data:')) continue;

    const payload = chunk.replace(/^data:\s*/, '');
    if (!payload || payload === '[DONE]') continue;

    const json = JSON.parse(payload);
    const hexAudio = json?.data?.audio;
    if (!hexAudio) continue; // status-only 包直接跳过

    allHexChunks.push(hexAudio);
    appendHexChunk(hexAudio);

    if (!started) {
      started = true;
      audio.play();
    }
  }
}

const fullHexAudio = allHexChunks.join('');
console.log('完整音频 hex 长度:', fullHexAudio.length);
```


## 多触点事件处理

我已经把这些触点封装进 `MiniMaxTTSPlayer`：

- `request`：请求刚发出
- `message`：收到一段 SSE JSON
- `chunk`：收到一段音频块
- `playing`：音频开始播放
- `waiting`：音频缓冲中
- `ended`：音频播放结束
- `done`：流读取完成
- `error`：请求或播放错误

## 普通网页里怎么用

```html
<script type="module">
  import { MiniMaxTTSPlayer } from './minimax-web-tts.js';
  const player = new MiniMaxTTSPlayer();

  player.addEventListener('playing', () => console.log('开始播放'));
  player.addEventListener('chunk', (e) => console.log('收到音频块', e.detail));
  player.addEventListener('error', (e) => console.error(e.detail));

  await player.start('Hello MiniMax', {
    baseURL: 'https://api.minimaxi.chat/v1/t2a_v2?GroupId=',
    groupId: '你的GroupId',
    apiKey: '你的ApiKey',
    voiceId: 'English_Graceful_Lady',
    model: 'speech-01-turbo',
    speed: 1.0,
    lang: 'en',
    emotion: 'neutral'
  });
</script>
```

## 注意

- 浏览器首次播放通常需要用户手势触发，所以最好把 `player.start(...)` 放到按钮点击事件里。
- `speed` 请用小数，不要用 `parseInt`。
- 仓库原实现里使用的是 `emotio` 字段；如果你使用的官方接口版本要求 `emotion`，请按官方文档调整。
- 如果你不想在前端暴露 API Key，建议改成你自己的服务端代理。
