# OpenClaw QQ Plugin (OneBot v11)

> 中文版: [README.md](../../README.md)

## 📚 Docs Hub

- [Docs Home](../../docs/index.en.md)
- [3-minute Quickstart](../../docs/quickstart.en.md)
- [Config Reference (Grouped)](../../docs/config-reference.en.md)
- [Advanced Features & Full Parameters](../../docs/advanced.en.md)
- [NapCat Deployment Guide](../../deploy/napcat/README.en.md)

## 📢 Official Support Channel (Primary)

**Designated forum for this plugin:**

**https://aiya.de5.net/c/25-category/25**

- We do not run a QQ support group.
- All questions and feedback are centralized on the forum for long-term searchability.

## What This Plugin Does

Provides OneBot v11 QQ channel integration for OpenClaw:

- Direct and group message handling
- Group @mention trigger control
- Multimodal support (image/voice/file depending on your OneBot server)
- Production-oriented reliability features (reconnect/retry/fallback)

## Feature Overview (Quick Fit Check)

### Core Channel Capabilities

- OneBot v11 WebSocket integration (NapCat / Lagrange, etc.)
- Direct, group, and QQ Guild message handling
- Keyword triggers, @mention triggers, allowlist/blocklist controls

### Production Reliability

- Connection self-healing and failed-send requeue
- Auto-retry plus Fast-Fail error shortcuts
- Active Model Failover (switch to fallback models when primary fails)
- Same-session anti-drop queue and "interrupt old reply on new message"

### Context & Interaction Enhancements

- Recursive reply/forward parsing with layered context injection
- Hidden QQ gateway metadata injection for more stable routing/intent handling
- Auto merged-forward mode for long replies
- Markdown readability formatting, anti-risk mode, empty-reply fallback

### Governance & Safety

- `admins` as permission source
- `adminOnlyChat` to restrict chat triggers
- `allowedGroups` / `blockedUsers` ingress control
- Optional auto-approve for friend requests and group invites

## Best-fit Scenarios

- You need more than "basic QQ chat": reliability and lower miss/dropped replies matter.
- Your groups are active and you need anti-abuse and permission boundaries.
- You prefer starting from a minimal config and enabling advanced features gradually.

## Positioning Note

If you only want an ultra-minimal channel layer, a lighter plugin may fit better.  
This plugin is positioned as a OneBot channel that can start simple and scale to production-grade behavior.

## 3-minute Quickstart

### 1. Prerequisites

- OpenClaw is installed and running
- A OneBot v11 server is running (NapCat/Lagrange recommended)
- `message_post_format=array` in OneBot config

### 2. Install

```bash
cd openclaw/extensions
git clone https://github.com/constansino/openclaw_qq.git qq
cd ../..
pnpm install && pnpm build
```

### 3. Minimal Config

Edit `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "your_token",
      "requireMention": true
    }
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  }
}
```

### 4. Start & Verify

```bash
openclaw gateway restart
```

Check:

- Bot replies in DM
- Bot replies when @mentioned in groups
- No persistent auth/reconnect errors in logs

## Suggested Reading Order

1. [Quickstart](../../docs/quickstart.en.md)
2. [Config Reference](../../docs/config-reference.en.md)
3. [Advanced Features](../../docs/advanced.en.md)
4. [Deployment Guide](../../deploy/napcat/README.en.md)
