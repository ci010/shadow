---
name: userlink
description: Create or bind the current inbound account to a user profile using `userlink <Name>`.
metadata:
  category: integration
---

# User Link Profile

Use this skill to bind accounts to profiles and verify cross-channel identity links.

## When to Use

- When you learn the user's preferred name or they introduce themselves
- Use the **display name** from the message (the `name` field in user messages), NOT the sender ID

## Commands

```bash
userlink <Name>
userlink verify <targetChannel> <targetSenderId>
userlink confirm <code>
```

**Important**: `<Name>` should be the user's human-readable name (e.g., `CI010`, `John`), not their platform ID.

## Examples

If a user message shows `"name":"CI010"`, run:
```bash
userlink CI010
```

If user says "call me Jane":
```bash
userlink Jane
```

## Notes

- Creates `memory/identities/<Name>.md` if missing
- Updates account mapping in `memory/identities/index.json`
- `userlink verify ...` sends a confirmation question to the target account's latest known chat
- Target account must reply with `userlink confirm <code>` to complete linking
- New accounts are auto-inferred from display name if not linked yet
