-- users → broker_* 이관은 Node 스크립트(migrate_users_kiwoom_to_broker.js)에서 수행.
-- 수동으로 컬럼만 제거할 때 (이관 완료 후):
ALTER TABLE users DROP COLUMN IF EXISTS kiwoom_app_key;
ALTER TABLE users DROP COLUMN IF EXISTS kiwoom_app_secret;
ALTER TABLE users DROP COLUMN IF EXISTS kiwoom_access_token;
ALTER TABLE users DROP COLUMN IF EXISTS kiwoom_token_expires_at;
ALTER TABLE users DROP COLUMN IF EXISTS kiwoom_account_no;
