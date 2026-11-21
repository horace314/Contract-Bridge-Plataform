CREATE TABLE IF NOT EXISTS completed_boards (
  id SERIAL PRIMARY KEY,
  table_id VARCHAR(128) NOT NULL,
  board_number INT NOT NULL,
  dealer VARCHAR(4) NOT NULL,
  vulnerability VARCHAR(16) NOT NULL,
  contract_text VARCHAR(32),
  declarer VARCHAR(4),
  tricks_ns INT NOT NULL DEFAULT 0,
  tricks_ew INT NOT NULL DEFAULT 0,
  score_ns INT NOT NULL DEFAULT 0,
  score_ew INT NOT NULL DEFAULT 0,
  pbn TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
