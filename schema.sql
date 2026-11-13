CREATE DATABASE IF NOT EXISTS chat_app CHARACTER SET utf8mb4;
USE chat_app;

CREATE TABLE IF NOT EXISTS users (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chats (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type            ENUM('direct','group') NOT NULL DEFAULT 'direct',
  name            VARCHAR(100) NULL,
  direct_key      VARCHAR(50) NULL,   -- "minId:maxId" for direct chats; UNIQUE => one chat per pair
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_message_at TIMESTAMP(3) NULL,
  UNIQUE KEY uq_direct_key (direct_key),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   BIGINT UNSIGNED NOT NULL,
  user_id   BIGINT UNSIGNED NOT NULL,
  role      ENUM('admin','member') NOT NULL DEFAULT 'member',
  joined_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (chat_id, user_id),
  KEY idx_user (user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Messages (previously Firestore)
CREATE TABLE IF NOT EXISTS messages (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,   -- increases with send order
  chat_id    BIGINT UNSIGNED NOT NULL,
  sender_id  BIGINT UNSIGNED NOT NULL,
  text       TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  edited_at  TIMESTAMP(3) NULL,
  deleted    TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_chat_id_id (chat_id, id),
  FOREIGN KEY (chat_id)   REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Read receipts: one row per (message, reader)
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  read_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Last seen message per user per chat
CREATE TABLE IF NOT EXISTS chat_last_seen (
  chat_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id)    REFERENCES chats(id)    ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB;
