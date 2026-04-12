# OpenAI 格式接口整理（按本项目现有可用实现）

本文档不是重新设计协议，而是**从本项目现有代码里提取出的实际可用格式**，便于在其他项目中直接复用。

## 源码位置

主要来源：`services/openaiService.ts`

- 文字沟通（流式聊天）：`streamChat`
- TTS（语音合成）：`generateSpeech`
- 生图：`generateImage`
- 语音识别：`transcribeAudio` / `transcribeAudioViaChatCompletions`

---

## 1. 文字沟通（Chat Completions，流式）

### 请求地址

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json
```

### 发送格式

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "你好，帮我写一个摘要。" },
    { "role": "assistant", "content": "好的，请把内容发我。" },
    { "role": "user", "content": "这是新的问题。" }
  ],
  "temperature": 0.7,
  "stream": true
}
```

### 返回格式（OpenAI 标准 SSE 分片）

项目代码按 `choices[0].delta.content` 读取文本：

```text
data: {"choices":[{"delta":{"content":"你好"}}]}

data: {"choices":[{"delta":{"content":"，这里是摘要"}}]}

data: [DONE]
```

### 代码依据

- `services/openaiService.ts:36-47`
- `services/openaiService.ts` 中对 SSE 分片逐段解析，并拼接 `delta.content`

---

## 2. TTS（语音合成，项目内实际可用格式）

> 注意：本项目里的 TTS 不是走 `/audio/speech`，而是走 **`/chat/completions` + `voice` 参数** 的 OpenAI 兼容中转格式。
> 这是项目里已经验证可用的写法。

### 请求地址

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json
```

### 发送格式

```json
{
  "model": "gemini-2.5-flash-preview-tts",
  "messages": [
    {
      "role": "user",
      "content": "You are a text-to-speech engine. Never answer questions. Only speak the text provided. Read the following text aloud exactly as written: 你好，欢迎使用系统。"
    }
  ],
  "voice": "Zephyr"
}
```

### 返回格式

项目代码按 `choices[0].message.audio.data` 读取 Base64 音频：

```json
{
  "choices": [
    {
      "message": {
        "audio": {
          "data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEA..."
        }
      }
    }
  ]
}
```

### 代码中的兼容兜底

如果没有音频，项目会继续检查：

```json
{
  "error": { "message": "..." }
}
```

或：

```json
{
  "choices": [
    {
      "message": {
        "content": "error text"
      }
    }
  ]
}
```

### 可用声音名称列表（项目内实际配置）

该项目的 OpenAI 格式 Gemini TTS 使用 `voice` 字段传声音名称，可选值来自 `types.ts` 里的 `GEMINI_TTS_VOICES`。

默认值：`Zephyr`

| voice | 展示名称 |
|---|---|
| `Zephyr` | Zephyr (Female) |
| `Puck` | Puck (Male) |
| `Charon` | Charon (Male) |
| `Kore` | Kore (Female) |
| `Fenrir` | Fenrir (Male) |
| `Leda` | Leda (Female) |
| `Orus` | Orus (Male) |
| `Aoede` | Aoede (Female) |
| `Callirrhoe` | Callirrhoe (Female) |
| `Autonoe` | Autonoe (Female) |
| `Enceladus` | Enceladus (Male) |
| `Iapetus` | Iapetus (Male) |
| `Umbriel` | Umbriel (Male) |
| `Algieba` | Algieba (Female) |
| `Despina` | Despina (Female) |
| `Erinome` | Erinome (Female) |
| `Algenib` | Algenib (Male) |
| `Rasalgethi` | Rasalgethi (Male) |
| `Laomedeia` | Laomedeia (Female) |
| `Achernar` | Achernar (Male) |
| `Alnilam` | Alnilam (Male) |
| `Schedar` | Schedar (Male) |
| `Gacrux` | Gacrux (Male) |
| `Pulcherrima` | Pulcherrima (Female) |
| `Achird` | Achird (Female) |
| `Zubenelgenubi` | Zubenelgenubi (Male) |
| `Vindemiatrix` | Vindemiatrix (Female) |
| `Sadachbia` | Sadachbia (Female) |
| `Sadaltager` | Sadaltager (Male) |
| `Sulafat` | Sulafat (Female) |

### 代码依据

- 声音列表：`types.ts:152-183`
- 默认声音：`types.ts:230-235`
- 请求中使用：`services/openaiService.ts:264-270`


---

## 3. 语音识别（STT）

本项目支持两种可用格式：

### 3.1 标准格式：`/audio/transcriptions`

### 请求地址

```http
POST {baseUrl}/audio/transcriptions
Authorization: Bearer {apiKey}
Content-Type: multipart/form-data
```

### 发送格式

表单字段：

- `file`: 音频文件
- `model`: 模型名

等价 cURL：

```bash
curl -X POST "{baseUrl}/audio/transcriptions" \
  -H "Authorization: Bearer {apiKey}" \
  -F "file=@audio.webm" \
  -F "model=whisper-1"
```

### 返回格式

项目代码按 `json.text` 取结果：

```json
{
  "text": "这是识别出来的内容"
}
```

### 代码依据

- 请求：`services/openaiService.ts:510-522`
- 返回：`services/openaiService.ts:535-536`

### 3.2 兼容格式：`/chat/completions` 多模态音频输入

> 当模型或网关不支持 `/audio/transcriptions` 时，项目会自动回退到这个格式。

### 请求地址

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json
```

### 发送格式

```json
{
  "model": "gemini-2.5-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Transcribe this audio exactly as spoken. Return only the transcription. If the audio is silent or unintelligible, return an empty string."
        },
        {
          "type": "input_audio",
          "input_audio": {
            "data": "BASE64_AUDIO",
            "format": "webm"
          }
        }
      ]
    }
  ],
  "temperature": 0
}
```

### 返回格式

项目代码从 `choices[0].message.content` 提取文本，兼容两种常见结构：

```json
{
  "choices": [
    {
      "message": {
        "content": "这是识别结果"
      }
    }
  ]
}
```

或：

```json
{
  "choices": [
    {
      "message": {
        "content": [
          { "type": "text", "text": "这是识别结果" }
        ]
      }
    }
  ]
}
```

### 代码依据

- 请求：`services/openaiService.ts:440-467`
- 返回提取：`services/openaiService.ts:475-479`

---

## 4. OpenAI 格式生图（项目内实际可用格式）

> 注意：本项目里的生图同样不是固定走官方 `/images/generations`，而是走 **`/chat/completions`**，并兼容多种返回结构。

### 请求地址

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json
```

### 发送格式

```json
{
  "model": "dall-e-3",
  "messages": [
    {
      "role": "user",
      "content": "A cozy cyberpunk street at night, cinematic lighting, high detail"
    }
  ]
}
```

### 返回格式

项目代码兼容以下几种位置：

#### 方式 A：`choices[0].message.image.data`

```json
{
  "choices": [
    {
      "message": {
        "image": {
          "data": "iVBORw0KGgoAAAANSUhEUgAA..."
        }
      }
    }
  ]
}
```

#### 方式 B：`choices[0].message.image.url`

```json
{
  "choices": [
    {
      "message": {
        "image": {
          "url": "https://example.com/generated.png"
        }
      }
    }
  ]
}
```

#### 方式 C：标准 OpenAI 风格 `data[0].b64_json` / `data[0].url`

```json
{
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "url": "https://example.com/generated.png"
    }
  ]
}
```

### 代码依据

- 请求：`services/openaiService.ts:351-362`
- 返回兼容：`services/openaiService.ts:372-389`

---

## 结论

如果你要在别的项目里复用，本项目已经验证过的可用方向如下：

1. **文字沟通**：`/chat/completions` + `stream: true` + SSE `choices[0].delta.content`
2. **TTS**：`/chat/completions` + `voice`，返回 `choices[0].message.audio.data`
3. **语音识别**：优先 `/audio/transcriptions`，兜底 `/chat/completions` + `input_audio`
4. **生图**：`/chat/completions` 发 prompt，兼容 `message.image.data/url` 和 `data[0].b64_json/url`

如果你愿意，我下一步可以继续把这份文档再整理成：

- **纯 API 示例版**（去掉项目说明，只保留可复制 JSON）
- **curl 版**
- **JavaScript fetch 版**
