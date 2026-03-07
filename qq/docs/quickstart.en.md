# 3-minute Quickstart

## 1. Prerequisites

- OpenClaw is installed and running.
- A OneBot v11 server is running (NapCat or Lagrange recommended).
- In OneBot config, `message_post_format` must be set to `array`.

## 2. Install Plugin

```bash
cd openclaw/extensions
git clone https://github.com/constansino/openclaw_qq.git qq
cd ../..
pnpm install && pnpm build
```

> If you installed OpenClaw globally (`npm install -g openclaw`) and only update the extension directory, you usually only need `npm install` in `~/.openclaw/extensions/qq`, then run `openclaw gateway restart`.

## 3. Minimal Config

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

## 4. Start & Verify

```bash
openclaw gateway restart
```

Verification checklist:

- DM the bot and verify it replies.
- @mention the bot in a group and verify it replies.
- No persistent reconnect/auth errors in logs.

## 5. Next Steps

- Admin and allow/block controls: [Config Reference](./config-reference.en.md)
- Container deployment details: [NapCat Guide](../deploy/napcat/archive/README.en.legacy.md)
