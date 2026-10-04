-- broker_accounts: 계좌 표시명
ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS account_name VARCHAR(100);
