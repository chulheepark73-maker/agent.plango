-- broker_accounts: 국내 수수료·증권거래세율 (소수율, 예: 0.000125 = 0.0125%)
ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS buy_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.000125;

ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS sell_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.000125;

ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS sell_tax_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.0018;

-- US 수수료·거래세율
ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS us_buy_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0;

ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS us_sell_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0;

ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS us_sell_tax_rate NUMERIC(12, 8) NOT NULL DEFAULT 0;
