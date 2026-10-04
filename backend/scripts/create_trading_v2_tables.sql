-- planGo Trading V2 (ERD)
-- 기존 auto_tradings / us_auto_tradings 와 분리.
-- hub 테이블명: trading_plans (이미지의 auto_tradings 역할)

-- 1) 증권 계좌 (키움 키는 users에 남아 있을 수 있음 — sync 가능)
CREATE TABLE IF NOT EXISTS broker_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker VARCHAR(50) NOT NULL DEFAULT 'kiwoom',
  account_no VARCHAR(50),
  account_name VARCHAR(100),
  account_type VARCHAR(30),
  is_active BOOLEAN NOT NULL DEFAULT true,
  buy_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.000125,
  sell_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.000125,
  sell_tax_rate NUMERIC(12, 8) NOT NULL DEFAULT 0.0018,
  us_buy_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0,
  us_sell_fee_rate NUMERIC(12, 8) NOT NULL DEFAULT 0,
  us_sell_tax_rate NUMERIC(12, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_accounts_user_broker
  ON broker_accounts (user_id, broker);

CREATE INDEX IF NOT EXISTS idx_broker_accounts_user_id
  ON broker_accounts (user_id);

-- 2) 종목 마스터
CREATE TABLE IF NOT EXISTS instruments (
  id BIGSERIAL PRIMARY KEY,
  market VARCHAR(10) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  name VARCHAR(200),
  currency VARCHAR(10) NOT NULL DEFAULT 'KRW',
  country VARCHAR(10),
  mrkt_tp VARCHAR(10),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (market, symbol)
);

CREATE INDEX IF NOT EXISTS idx_instruments_market_symbol
  ON instruments (market, symbol);

ALTER TABLE instruments ADD COLUMN IF NOT EXISTS mrkt_tp VARCHAR(10);

-- 3) 거래소/베뉴
CREATE TABLE IF NOT EXISTS instrument_venues (
  id BIGSERIAL PRIMARY KEY,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  exchange VARCHAR(20) NOT NULL,
  broker_symbol VARCHAR(64),
  is_tradable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (instrument_id, exchange)
);

CREATE INDEX IF NOT EXISTS idx_instrument_venues_instrument_id
  ON instrument_venues (instrument_id);

-- 4) 자동매매 플랜 hub (이미지 auto_tradings)
CREATE TABLE IF NOT EXISTS trading_plans (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_account_id BIGINT REFERENCES broker_accounts(id) ON DELETE SET NULL,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id),
  venue_id BIGINT REFERENCES instrument_venues(id) ON DELETE SET NULL,
  strategy_type VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  strategy_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_cycle_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, instrument_id, venue_id, strategy_type)
);

CREATE INDEX IF NOT EXISTS idx_trading_plans_user_status
  ON trading_plans (user_id, status);

CREATE INDEX IF NOT EXISTS idx_trading_plans_instrument_id
  ON trading_plans (instrument_id);

-- 5) 사이클
CREATE TABLE IF NOT EXISTS trading_cycles (
  id BIGSERIAL PRIMARY KEY,
  trading_id BIGINT NOT NULL REFERENCES trading_plans(id) ON DELETE CASCADE,
  cycle_no INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (trading_id, cycle_no)
);

CREATE INDEX IF NOT EXISTS idx_trading_cycles_trading_id
  ON trading_cycles (trading_id);

-- current_cycle_id → trading_cycles (순환 FK: cycles 생성 후 추가)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_trading_plans_current_cycle'
  ) THEN
    ALTER TABLE trading_plans
      ADD CONSTRAINT fk_trading_plans_current_cycle
      FOREIGN KEY (current_cycle_id) REFERENCES trading_cycles(id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'fk_trading_plans_current_cycle skip: %', SQLERRM;
END $$;

-- 6) 스테이지
CREATE TABLE IF NOT EXISTS trading_stages (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES trading_cycles(id) ON DELETE CASCADE,
  side VARCHAR(10) NOT NULL,
  stage INT NOT NULL,
  percent NUMERIC(12, 4),
  target_price NUMERIC(18, 6),
  target_amount NUMERIC(18, 2),
  target_qty NUMERIC(18, 4),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (cycle_id, side, stage),
  CHECK (side IN ('BUY', 'SELL')),
  CHECK (stage >= 1)
);

CREATE INDEX IF NOT EXISTS idx_trading_stages_cycle_id
  ON trading_stages (cycle_id);

-- 7) 주문
CREATE TABLE IF NOT EXISTS trading_orders (
  id BIGSERIAL PRIMARY KEY,
  trading_id BIGINT NOT NULL REFERENCES trading_plans(id) ON DELETE CASCADE,
  stage_id BIGINT REFERENCES trading_stages(id) ON DELETE SET NULL,
  broker_account_id BIGINT REFERENCES broker_accounts(id) ON DELETE SET NULL,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id),
  venue_id BIGINT REFERENCES instrument_venues(id) ON DELETE SET NULL,
  side VARCHAR(10) NOT NULL,
  order_type VARCHAR(20) NOT NULL DEFAULT 'LIMIT',
  requested_price NUMERIC(18, 6),
  requested_qty NUMERIC(18, 4),
  requested_amount NUMERIC(18, 2),
  broker_order_no VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ordered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (side IN ('BUY', 'SELL'))
);

CREATE INDEX IF NOT EXISTS idx_trading_orders_trading_id
  ON trading_orders (trading_id);

CREATE INDEX IF NOT EXISTS idx_trading_orders_broker_order_no
  ON trading_orders (broker_order_no)
  WHERE broker_order_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trading_orders_stage_id
  ON trading_orders (stage_id);

-- 주문 ↔ 사이클 (무한매매 회차 구분; 분할은 stage.cycle_id와 병행)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trading_orders' AND column_name = 'cycle_id'
  ) THEN
    ALTER TABLE trading_orders
      ADD COLUMN cycle_id BIGINT REFERENCES trading_cycles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trading_orders_cycle_id
  ON trading_orders (cycle_id);

-- 차수 스냅샷 (stage DELETE/rematch 후에도 매도완료 표시가 안 바뀌게)
ALTER TABLE trading_orders ADD COLUMN IF NOT EXISTS stage_no INT;

-- 주문 사유 (LIQUIDATE = 일괄청산: 체결 후 차수 재오픈·새 cycle 없이 플랜 종료)
ALTER TABLE trading_orders ADD COLUMN IF NOT EXISTS order_reason VARCHAR(20);
UPDATE trading_orders o
SET stage_no = s.stage
FROM trading_stages s
WHERE s.id = o.stage_id AND o.stage_no IS NULL;

-- 기존 주문: 플랜 current_cycle 또는 stage.cycle_id 로 백필
UPDATE trading_orders o
SET cycle_id = COALESCE(
  (SELECT s.cycle_id FROM trading_stages s WHERE s.id = o.stage_id),
  (SELECT p.current_cycle_id FROM trading_plans p WHERE p.id = o.trading_id)
)
WHERE o.cycle_id IS NULL;

-- 8) 체결
CREATE TABLE IF NOT EXISTS trading_fills (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES trading_orders(id) ON DELETE CASCADE,
  fill_price NUMERIC(18, 6) NOT NULL,
  fill_qty NUMERIC(18, 4) NOT NULL,
  fill_amount NUMERIC(18, 2),
  broker_fill_no VARCHAR(64),
  filled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_fills_order_id
  ON trading_fills (order_id);

-- 9) 관심종목 V2 (KRX/US 통합 — instruments FK, sort_order 없음)
CREATE TABLE IF NOT EXISTS watchlist_v2 (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  group_no INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, instrument_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_v2_user_group
  ON watchlist_v2 (user_id, group_no);

CREATE INDEX IF NOT EXISTS idx_watchlist_v2_instrument_id
  ON watchlist_v2 (instrument_id);
