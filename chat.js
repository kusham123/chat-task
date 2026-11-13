const express = require('express');
const db = require('../db');
const { HttpError, asyncHandler, parseId, parseText } = require('../utils');
const { getChat, requireMember, assertUsersExist } = require('../membership');

const router = express.Router();

const iso = (d) => (d ? new Date(d).toISOString() : null);

const serializeMessage = (m, readBy) => ({
  id: m.id,
  senderId: m.sender_id,
  text: m.deleted ? null : m.text,
  createdAt: iso(m.created_at),
  editedAt: iso(m.edited_at),
  deleted: !!m.deleted,
  ...(readBy ? { readBy } : {}),
});

async function getMessageOr404(chatId, messageId) {
  const [rows] = await db.query('SELECT * FROM messages WHERE id = ? AND chat_id = ?', [messageId, chatId]);
  if (!rows.length) throw new HttpError(404, 'Message not found');
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* 1. Create or get 1:1 chat                                          */
/* ------------------------------------------------------------------ */
router.post('/chat/create', asyncHandler(async (req, res) => {
  const a = parseId(req.body.userAId, 'userAId');
  const b = parseId(req.body.userBId, 'userBId');
  if (a === b) throw new HttpError(400, 'userAId and userBId must differ');
  await assertUsersExist([a, b]);

  const directKey = `${Math.min(a, b)}:${Math.max(a, b)}`;
  const find = async () => {
    const [rows] = await db.query('SELECT id FROM chats WHERE direct_key = ?', [directKey]);
    return rows[0]?.id;
  };

  let chatId = await find();
  if (chatId) return res.json({ chatId, created: false });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      "INSERT INTO chats (type, direct_key, created_by) VALUES ('direct', ?, ?)",
      [directKey, a]
    );
    await conn.query('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?), (?, ?)', [r.insertId, a, r.insertId, b]);
    await conn.commit();
    return res.status(201).json({ chatId: r.insertId, created: true });
  } catch (err) {
    await conn.rollback();
    // A concurrent request created it first (UNIQUE direct_key) -> return that chat.
    if (err.code === 'ER_DUP_ENTRY') {
      chatId = await find();
      if (chatId) return res.json({ chatId, created: false });
    }
    throw err;
  } finally {
    conn.release();
  }
}));

/* ------------------------------------------------------------------ */
/* 2. Send message                                                    */
/* ------------------------------------------------------------------ */
router.post('/chat/:chatId/message/send', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const senderId = parseId(req.body.senderId, 'senderId');
  const text = parseText(req.body.text);
  await requireMember(chatId, senderId);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)', [chatId, senderId, text]);
    const [rows] = await conn.query('SELECT * FROM messages WHERE id = ?', [r.insertId]);
    await conn.query('UPDATE chats SET last_message_at = ? WHERE id = ?', [rows[0].created_at, chatId]);
    await conn.commit();
    res.status(201).json({ message: serializeMessage(rows[0]) });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

/* ------------------------------------------------------------------ */
/* 3. Get messages (oldest -> newest)                                 */
/*    ?userId=<member>&limit=50 (max 100)&before=<messageId>          */
/*    Returns the latest `limit` messages; `before` pages backwards.  */
/* ------------------------------------------------------------------ */
router.get('/chat/:chatId/messages', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const userId = parseId(req.query.userId, 'userId (query)');
  await requireMember(chatId, userId);

  let limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'limit must be a positive integer');
  limit = Math.min(limit, 100);

  const params = [chatId];
  let where = 'chat_id = ?';
  if (req.query.before !== undefined) {
    where += ' AND id < ?';
    params.push(parseId(req.query.before, 'before'));
  }
  // id is auto-increment, so id order == send order (also breaks created_at ties)
  const [rows] = await db.query(`SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`, [...params, limit]);
  rows.reverse();

  // Attach read receipts in one extra query
  const readBy = {};
  if (rows.length) {
    const [receipts] = await db.query(
      'SELECT message_id, user_id, read_at FROM message_receipts WHERE message_id IN (?)',
      [rows.map((r) => r.id)]
    );
    for (const rc of receipts) (readBy[rc.message_id] ||= []).push({ userId: rc.user_id, readAt: iso(rc.read_at) });
  }

  res.json({
    messages: rows.map((m) => serializeMessage(m, readBy[m.id] || [])),
    hasMore: rows.length === limit,
    nextBefore: rows.length ? rows[0].id : null,
  });
}));

/* ------------------------------------------------------------------ */
/* 4. Mark message read (idempotent; first read time is preserved)    */
/* ------------------------------------------------------------------ */
router.post('/chat/:chatId/message/:messageId/read', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const messageId = parseId(req.params.messageId, 'messageId');
  const userId = parseId(req.body.userId, 'userId');
  await requireMember(chatId, userId);

  const msg = await getMessageOr404(chatId, messageId);
  if (msg.sender_id === userId) throw new HttpError(400, 'Cannot mark your own message as read');

  await db.query('INSERT IGNORE INTO message_receipts (message_id, user_id) VALUES (?, ?)', [messageId, userId]);
  const [rows] = await db.query('SELECT read_at FROM message_receipts WHERE message_id = ? AND user_id = ?', [messageId, userId]);
  res.json({ messageId, userId, readAt: iso(rows[0].read_at) });
}));

/* ------------------------------------------------------------------ */
/* 5. Update last seen message (only ever moves forward)              */
/* ------------------------------------------------------------------ */
router.post('/chat/:chatId/lastseen', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const userId = parseId(req.body.userId, 'userId');
  const messageId = parseId(req.body.messageId, 'messageId');
  await requireMember(chatId, userId);
  await getMessageOr404(chatId, messageId);

  const [[current]] = await db.query('SELECT message_id FROM chat_last_seen WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  const updated = !current || messageId > current.message_id;

  // GREATEST keeps it monotonic even under concurrent requests
  await db.query(
    `INSERT INTO chat_last_seen (chat_id, user_id, message_id) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       updated_at = IF(VALUES(message_id) > message_id, CURRENT_TIMESTAMP(3), updated_at),
       message_id = GREATEST(message_id, VALUES(message_id))`,
    [chatId, userId, messageId]
  );

  const [[row]] = await db.query('SELECT message_id, updated_at FROM chat_last_seen WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  res.json({ userId, messageId: row.message_id, updated, updatedAt: iso(row.updated_at) });
}));

/* ================================================================== */
/* BONUS: group chats                                                 */
/* ================================================================== */
router.post('/chat/group/create', asyncHandler(async (req, res) => {
  const creatorId = parseId(req.body.creatorId, 'creatorId');
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  if (!Array.isArray(req.body.memberIds)) throw new HttpError(400, 'memberIds must be an array');
  const memberIds = [...new Set([creatorId, ...req.body.memberIds.map((id) => parseId(id, 'memberIds[]'))])];
  if (memberIds.length < 2) throw new HttpError(400, 'A group needs at least 2 members');
  await assertUsersExist(memberIds);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query("INSERT INTO chats (type, name, created_by) VALUES ('group', ?, ?)", [name, creatorId]);
    await conn.query(
      'INSERT INTO chat_members (chat_id, user_id, role) VALUES ?',
      [memberIds.map((id) => [r.insertId, id, id === creatorId ? 'admin' : 'member'])]
    );
    await conn.commit();
    res.status(201).json({ chatId: r.insertId, name, memberIds });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

async function requireGroupAdmin(chatId, actorId) {
  const chat = await getChat(chatId);
  if (chat.type !== 'group') throw new HttpError(400, 'Not a group chat');
  const m = await requireMember(chatId, actorId);
  if (m.role !== 'admin') throw new HttpError(403, 'Only group admins can do this');
  return chat;
}

router.post('/chat/:chatId/members', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const actorId = parseId(req.body.actorId, 'actorId');
  if (!Array.isArray(req.body.userIds) || !req.body.userIds.length) throw new HttpError(400, 'userIds must be a non-empty array');
  const userIds = [...new Set(req.body.userIds.map((id) => parseId(id, 'userIds[]')))];
  await requireGroupAdmin(chatId, actorId);
  await assertUsersExist(userIds);

  await db.query('INSERT IGNORE INTO chat_members (chat_id, user_id) VALUES ?', [userIds.map((id) => [chatId, id])]);
  res.status(201).json({ chatId, added: userIds });
}));

// Admin removes someone, or a member removes themselves (leave).
router.delete('/chat/:chatId/members/:userId', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const targetId = parseId(req.params.userId, 'userId');
  const actorId = parseId(req.body.actorId, 'actorId');
  const chat = await getChat(chatId);
  if (chat.type !== 'group') throw new HttpError(400, 'Not a group chat');
  const actor = await requireMember(chatId, actorId);
  if (actorId !== targetId && actor.role !== 'admin') throw new HttpError(403, 'Only admins can remove other members');

  const [r] = await db.query('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, targetId]);
  if (!r.affectedRows) throw new HttpError(404, 'Target user is not a member');

  // Never leave a group without an admin: promote the longest-standing member.
  await db.query(
    `UPDATE chat_members SET role = 'admin'
      WHERE chat_id = ?
        AND NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM chat_members WHERE chat_id = ? AND role = 'admin') x)
      ORDER BY joined_at LIMIT 1`,
    [chatId, chatId]
  );
  res.json({ chatId, removed: targetId });
}));

/* ================================================================== */
/* BONUS: edit / delete message (sender only; delete is soft)         */
/* ================================================================== */
router.patch('/chat/:chatId/message/:messageId', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const messageId = parseId(req.params.messageId, 'messageId');
  const userId = parseId(req.body.userId, 'userId');
  const text = parseText(req.body.text);
  await requireMember(chatId, userId);

  const msg = await getMessageOr404(chatId, messageId);
  if (msg.sender_id !== userId) throw new HttpError(403, 'Only the sender can edit this message');
  if (msg.deleted) throw new HttpError(410, 'Message was deleted');

  await db.query('UPDATE messages SET text = ?, edited_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [text, messageId]);
  res.json({ message: serializeMessage(await getMessageOr404(chatId, messageId)) });
}));

router.delete('/chat/:chatId/message/:messageId', asyncHandler(async (req, res) => {
  const chatId = parseId(req.params.chatId, 'chatId');
  const messageId = parseId(req.params.messageId, 'messageId');
  const userId = parseId(req.body.userId, 'userId');
  await requireMember(chatId, userId);

  const msg = await getMessageOr404(chatId, messageId);
  if (msg.sender_id !== userId) throw new HttpError(403, 'Only the sender can delete this message');

  // Soft delete keeps ordering, receipts and last-seen pointers valid.
  await db.query("UPDATE messages SET deleted = 1, text = '', edited_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [messageId]);
  res.json({ message: serializeMessage(await getMessageOr404(chatId, messageId)) });
}));

module.exports = router;
