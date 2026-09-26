# Messaging channels

Project settings → **Bots** configures QQ, Feishu, and Discord instances.
Each Project may have several bots per platform, with separate credentials,
sender policies, and runtime status. Providers and device pairing remain
App-wide. A saved bot configuration is not proof of platform delivery or
verified connectivity; the backend can be locally ready while a bot is
offline. Legacy WeChat/iLink adapters are not started by Project runtimes.

**Trusted group or channel IDs** declare that everyone able to read replies
in that conversation is trusted, not just the senders allowed to message the
bot. Unknown audiences receive restrained shared-conversation guidance.
Listing a Discord server or parent channel does not implicitly trust its
threads. Trust does not grant administrator or tool permissions. Changing a
policy refreshes future reusable-conversation requests, but cannot retract
an in-flight reply.

## QQ GROUP and C2C passive replies

Ordinary GROUP/C2C replies send the final summary, rather than every tool
result or intermediate model update. Questions and final errors are separate
messages. Guild channels and DMs use their existing progressive delivery.

For each accepted incoming message ID, Shadow conservatively allows up to
**5 GROUP** or **4 C2C** passive replies within **5 minutes** of the
gateway timestamp. These are local, documentation-derived safeguards, **not
live-runtime-verified platform guarantees**. Text, Markdown, decisions, and
attachments share the same allowance. The separate C2C streaming endpoint is
not implemented.

Replies are serialized and their `msg_seq` values reserved before I/O.
Unknown, expired, exhausted, or unaccepted sources fail delivery visibly.
A question answered later does not extend the originating message's window;
the conversation can complete in Shadow while QQ delivery fails. Attempts
are not refunded after a platform rejection or unknown send outcome, and
Shadow will not blindly retry a source that may have partly delivered.
Tracking is in memory and clears when the bot stops or is replaced. Missing,
skewed, or pre-restart timestamps cannot mint a new reply window.

See the platform's [GROUP endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
and [C2C endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
for current upstream rules. The C2C overview and `msg_id` description have
historically stated different windows; do not infer a longer safe deadline
from the overview alone.
