-- broker_account_credentials: 계좌별 API 자격증명 (앱 코드 연동은 추후)
CREATE TABLE IF NOT EXISTS broker_account_credentials (
  id BIGSERIAL PRIMARY KEY,
  broker_account_id BIGINT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  app_key_encrypted TEXT,
  app_secret_encrypted TEXT,
  app_key_expires_at TIMESTAMPTZ NULL,
  access_token_encrypted TEXT,
  access_token_expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_account_credentials_account
  ON broker_account_credentials (broker_account_id);
