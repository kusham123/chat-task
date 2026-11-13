# Chat Backend (Node.js + MySQL)

## Setup
```bash
npm install
mysql -u root -p < schema.sql      # safe to re-run (CREATE IF NOT EXISTS)
cp .env.example .env               # set MySQL credentials
npm start
```
Windows/WAMP: import `schema.sql` through phpMyAdmin, or use the `mysql.exe` bundled with WAMP.

## Tables
`users`, `chats`, `chat_members`, `messages`, `message_receipts`, `chat_last_seen`

## Endpoints
| # | Method & path | Body / query |
|---|---|---|
| 1 | `POST /chat/create` | `{userAId, userBId}` -> `{chatId, created}` (idempotent) |
| 2 | `POST /chat/:chatId/message/send` | `{senderId, text}` |
| 3 | `GET /chat/:chatId/messages?userId=1&limit=50[&before=msgId]` | oldest -> newest, includes `readBy` |
| 4 | `POST /chat/:chatId/message/:messageId/read` | `{userId}` |
| 5 | `POST /chat/:chatId/lastseen` | `{userId, messageId}` |
| 6 | `GET /user/:userId/chats` | chats with `memberIds` |
| - | `POST /user` | `{name}` (test helper) |
| B | `POST /chat/group/create` | `{creatorId, name, memberIds[]}` |
| B | `POST /chat/:chatId/members` | `{actorId, userIds[]}` (admin) |
| B | `DELETE /chat/:chatId/members/:userId` | `{actorId}` (admin or self-leave) |
| B | `PATCH /chat/:chatId/message/:messageId` | `{userId, text}` (sender) |
| B | `DELETE /chat/:chatId/message/:messageId` | `{userId}` (sender, soft delete) |

## Quick try
```bash
curl -X POST localhost:3000/user -H "Content-Type: application/json" -d "{\"name\":\"Alice\"}"
curl -X POST localhost:3000/user -H "Content-Type: application/json" -d "{\"name\":\"Bob\"}"
curl -X POST localhost:3000/chat/create -H "Content-Type: application/json" -d "{\"userAId\":1,\"userBId\":2}"
curl -X POST localhost:3000/chat/1/message/send -H "Content-Type: application/json" -d "{\"senderId\":1,\"text\":\"hi\"}"
curl "localhost:3000/chat/1/messages?limit=50&userId=2"
curl -X POST localhost:3000/chat/1/message/1/read -H "Content-Type: application/json" -d "{\"userId\":2}"
curl -X POST localhost:3000/chat/1/lastseen -H "Content-Type: application/json" -d "{\"userId\":2,\"messageId\":1}"
curl localhost:3000/user/1/chats
```

## Notes
- One direct chat per pair via UNIQUE `direct_key`; concurrent creates are safe.
- Message order uses the auto-increment `id` (with `created_at` for display).
- Read receipts keep the first read time; last seen only moves forward.
- Deletes are soft. User IDs come from the request body; use real auth (e.g. JWT) in production.
