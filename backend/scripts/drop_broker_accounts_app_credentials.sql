-- broker_accounts: 키움 키는 users에 유지, 계좌 테이블에서 제거
ALTER TABLE broker_accounts DROP COLUMN IF EXISTS app_key;
ALTER TABLE broker_accounts DROP COLUMN IF EXISTS app_secret;
