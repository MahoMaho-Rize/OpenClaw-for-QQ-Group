# GPT-SoVITS 语音合成部署与接口说明

QQ 插件通过 `/voice` 命令调用 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) API 实现语音合成（TTS）。本文档说明如何部署 GPT-SoVITS 服务并与 QQ 插件对接。

## 架构概览

```
用户发送 /voice <文本>
    ↓
QQ 插件 (channel.ts)
    ↓ POST /tts (JSON)
GPT-SoVITS API (port 9880)
    ↓ 返回 WAV 音频流
QQ 插件 → base64 编码 → [CQ:record] → NapCat → QQ
```

QQ 插件负责文本预处理（去除 Markdown/CQ 码、截断）和音频编码，GPT-SoVITS 只负责推理。

---

## 环境要求

| 项目 | 要求 |
|------|------|
| GPU | NVIDIA，建议 4GB+ VRAM（推理约占用 2GB） |
| Python | 3.10（推荐通过 Conda 管理） |
| PyTorch | 2.x，CUDA 版本与驱动匹配 |
| 磁盘 | GPT-SoVITS 本体 ~2GB + 预训练模型 ~3GB + 自训练模型 ~250MB |

---

## 部署步骤

### 1. 克隆 GPT-SoVITS

```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS.git
cd GPT-SoVITS
```

### 2. 创建 Conda 环境

```bash
conda create -n gpt-sovits python=3.10 -y
conda activate gpt-sovits
pip install -r requirements.txt
```

> **中国大陆注意**：HuggingFace 被墙，需设置镜像：
> ```bash
> export HF_ENDPOINT=https://hf-mirror.com
> ```

### 3. 下载预训练模型

GPT-SoVITS 需要以下基础模型（首次启动会自动下载，但国内可能失败）：

| 模型 | 路径 | 说明 |
|------|------|------|
| Chinese RoBERTa | `GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/` | 中文 BERT |
| CNHuBERT | `GPT_SoVITS/pretrained_models/chinese-hubert-base/` | 语音特征提取 |
| FastText | `GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin` | 语言检测 |
| open_jtalk | pyopenjtalk 包目录下 | 日语音素字典 |

如果自动下载失败，手动下载方式：

```bash
# FastText 语言检测模型
wget -O GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin \
  https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin

# open_jtalk 日语字典（如果需要日语 TTS）
# 找到 pyopenjtalk 包路径
JTALK_DIR=$(python -c "import pyopenjtalk; import os; print(os.path.dirname(pyopenjtalk.__file__))")
wget -O /tmp/open_jtalk_dic.tar.gz \
  https://ghfast.top/https://github.com/r9y9/open_jtalk/releases/download/v1.11.1/open_jtalk_dic_utf_8-1.11.tar.gz
mkdir -p "$JTALK_DIR/dic"
tar xzf /tmp/open_jtalk_dic.tar.gz -C "$JTALK_DIR/dic" --strip-components=1
```

### 4. 放置自训练模型

将你训练好的模型文件放到任意目录，例如：

```
~/gpt-sovits-models/YourModel/
├── YourModel-GPT.ckpt        # GPT (T2S) 权重
├── YourModel-SoVITS.pth      # SoVITS (VITS) 权重
└── ref_audio/
    └── reference.wav          # 参考音频（用于声音克隆）
```

### 5. 配置模型路径

编辑 `GPT_SoVITS/configs/tts_infer.yaml`，在 `custom` 配置段中填入模型路径：

```yaml
custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cuda
  is_half: true
  t2s_weights_path: /absolute/path/to/YourModel-GPT.ckpt
  vits_weights_path: /absolute/path/to/YourModel-SoVITS.pth
  version: v2
```

> `is_half: true` 使用 FP16 推理，显存占用更低、速度更快。如果遇到精度问题可改为 `false`。

### 6. 启动 API 服务

```bash
conda activate gpt-sovits
cd GPT-SoVITS
python api_v2.py -a 0.0.0.0 -p 9880
```

首次启动会加载模型，耗时较长。后续请求在 warmup 后通常 0.7-1.5s 完成。

### 7. 验证

```bash
curl -X POST http://127.0.0.1:9880/tts \
  -H "Content-Type: application/json" \
  -d '{
    "text": "你好，世界",
    "text_lang": "zh",
    "ref_audio_path": "/path/to/ref_audio/reference.wav",
    "prompt_text": "参考音频对应的文本",
    "prompt_lang": "zh",
    "media_type": "wav",
    "streaming_mode": false
  }' \
  --output test.wav

# 如果生成了有效的 wav 文件，说明部署成功
file test.wav
```

---

## 设置为系统服务（可选）

创建 systemd user service 实现开机自启和崩溃自动重启：

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/gpt-sovits.service << 'EOF'
[Unit]
Description=GPT-SoVITS TTS API
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/GPT-SoVITS
ExecStart=/path/to/miniconda3/envs/gpt-sovits/bin/python api_v2.py -a 0.0.0.0 -p 9880
Restart=on-failure
RestartSec=10
StandardOutput=append:/tmp/gpt-sovits-api.log
StandardError=append:/tmp/gpt-sovits-api.log
Environment=HF_ENDPOINT=https://hf-mirror.com
Environment=CUDA_VISIBLE_DEVICES=0

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable gpt-sovits
systemctl --user start gpt-sovits
```

管理命令：

```bash
systemctl --user status gpt-sovits    # 查看状态
systemctl --user restart gpt-sovits   # 重启
journalctl --user -u gpt-sovits -f    # 查看日志
```

---

## API 接口说明

### `POST /tts` — 文本转语音

**请求**（JSON）：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:---:|--------|------|
| `text` | string | 是 | - | 要合成的文本 |
| `text_lang` | string | 是 | - | 文本语言：`zh`、`en`、`ja`、`auto` 等 |
| `ref_audio_path` | string | 是 | - | 参考音频的绝对路径 |
| `prompt_text` | string | 否 | `""` | 参考音频对应的文本（提供后合成质量更好） |
| `prompt_lang` | string | 是 | - | 参考音频文本的语言 |
| `media_type` | string | 否 | `"wav"` | 输出格式：`wav`、`ogg` 等 |
| `streaming_mode` | bool/int | 否 | `false` | 流式输出：`false`=关闭，`true`/`1`=最佳质量，`2`=中等，`3`=快速 |
| `top_k` | int | 否 | `15` | Top-K 采样 |
| `top_p` | float | 否 | `1.0` | Top-P 采样 |
| `temperature` | float | 否 | `1.0` | 采样温度 |
| `speed_factor` | float | 否 | `1.0` | 语速控制（>1 加速，<1 减速） |
| `seed` | int | 否 | `-1` | 随机种子（-1 = 随机） |
| `repetition_penalty` | float | 否 | `1.35` | 重复惩罚 |
| `batch_size` | int | 否 | `1` | 推理批次大小 |
| `text_split_method` | string | 否 | `"cut5"` | 文本切分方式 |
| `parallel_infer` | bool | 否 | `true` | 并行推理 |

**响应**：
- 成功：HTTP 200，body 为原始音频流（WAV/OGG 等），`Content-Type: audio/*`
- 失败：HTTP 400，JSON `{"message": "错误信息"}`

**请求示例**：

```json
{
  "text": "こんにちは、世界！",
  "text_lang": "auto",
  "ref_audio_path": "/home/user/models/ref_audio/sample.wav",
  "prompt_text": "デンショバトになってはいけませんわ。",
  "prompt_lang": "ja",
  "media_type": "wav",
  "streaming_mode": false
}
```

### `GET /set_gpt_weights` — 热切换 GPT 模型

```
GET /set_gpt_weights?weights_path=/path/to/new-model.ckpt
```

### `GET /set_sovits_weights` — 热切换 SoVITS 模型

```
GET /set_sovits_weights?weights_path=/path/to/new-model.pth
```

### `POST /control` — 服务控制

```json
{"command": "restart"}  // 重启服务
{"command": "exit"}     // 关闭服务
```

---

## QQ 插件对接配置

在 `openclaw.json` 的 `channels.qq` 中添加以下配置：

```json
{
  "channels": {
    "qq": {
      "enableSoVITS": true,
      "sovitsApiUrl": "http://127.0.0.1:9880",
      "sovitsRefAudioPath": "/absolute/path/to/reference.wav",
      "sovitsPromptText": "参考音频对应的文本",
      "sovitsPromptLang": "ja",
      "sovitsMaxChars": 500
    }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enableSoVITS` | 启用语音合成功能 |
| `sovitsApiUrl` | GPT-SoVITS API 地址 |
| `sovitsRefAudioPath` | 参考音频文件的**绝对路径** |
| `sovitsPromptText` | 参考音频中说话的内容（用于辅助合成） |
| `sovitsPromptLang` | 参考音频的语言（`zh`/`ja`/`en`） |
| `sovitsMaxChars` | 合成文本最大长度（超出部分截断，在句子边界处断开） |

配置完成后重启 gateway（`openclaw gateway restart`），然后在 QQ 中发送 `/voice 你好世界` 即可测试。

---

## QQ 插件内部处理流程

`/voice <文本>` 命令的完整处理流程：

1. **命令解析**：识别 `/voice` 命令，提取文本，设置 `voiceRequested = true`
2. **发送给模型**：文本作为 prompt 发给 AI 模型，模型生成回复
3. **文本预处理**（`generateSoVITSAudio` 函数）：
   - 去除 CQ 码（`[CQ:...]`）
   - 去除 Markdown 格式（`**粗体**`、`*斜体*`、`` `代码` ``、标题、列表等）
   - 在 `sovitsMaxChars` 限制内，在最近的句子边界（`。！？.!?\n`）处截断
4. **调用 API**：POST `/tts`，`text_lang: "auto"`（自动检测语言），30 秒超时
5. **音频编码**：将返回的 WAV 音频 base64 编码，包装为 `[CQ:record,file=base64://...]`
6. **发送**：仅发送语音，不发送文字。如果 TTS 失败，回退为文字消息。

---

## 性能参考

以下数据来自 NVIDIA RTX 5880 Ada (48GB VRAM) 环境：

| 指标 | 数值 |
|------|------|
| 模型加载（冷启动） | ~30s |
| 首次请求（warmup） | ~5s |
| 后续请求（中文，~50字） | ~0.7s |
| 后续请求（日语，~50字） | ~1.3s |
| 显存占用 | ~2GB |
| 输出格式 | WAV，32kHz，mono，16-bit |

较弱的 GPU（如 RTX 3060 6GB）也可运行，但推理时间会相应增加。

---

## 常见问题

### 启动时卡住不动

通常是模型文件下载失败导致。检查：
- `lid.176.bin`（FastText）是否存在于 `GPT_SoVITS/pretrained_models/fast_langdetect/`
- 日语 TTS 需要 open_jtalk 字典是否已安装
- 设置 `HF_ENDPOINT=https://hf-mirror.com` 后重试

### 合成的声音不像目标角色

- 确认 `ref_audio_path` 指向的参考音频质量良好（清晰、无背景噪音、3-10 秒）
- `prompt_text` 必须与参考音频内容**精确匹配**
- 尝试不同的参考音频

### QQ 中语音发送失败

- NapCat 会自动将 WAV 转换为 silk 格式，确认 NapCat 版本支持此转换
- 检查 `sovitsApiUrl` 是否可达：`curl http://127.0.0.1:9880/tts -X POST -d '{}' -H 'Content-Type: application/json'`
- 查看 gateway 日志中的 `[QQ]` 相关错误
