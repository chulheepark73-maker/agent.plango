-- PlanGo Agent 로컬 DB (SQLite) 스키마
-- 시각은 ISO-8601 UTC 문자열, BOOLEAN 은 0/1, JSON 은 문자열로 저장한다.

-- 에이전트 사용자 계정 사본 (원본·인증은 중앙 서버)
CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "phone_number" TEXT,
  "password" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS "broker_accounts" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL,
  "broker" TEXT NOT NULL DEFAULT 'kiwoom',
  "account_no" TEXT,
  "account_type" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "account_name" TEXT,
  "buy_fee_rate" NUMERIC NOT NULL DEFAULT 0.000125,
  "sell_fee_rate" NUMERIC NOT NULL DEFAULT 0.000125,
  "sell_tax_rate" NUMERIC NOT NULL DEFAULT 0.0018,
  "us_buy_fee_rate" NUMERIC NOT NULL DEFAULT 0,
  "us_sell_fee_rate" NUMERIC NOT NULL DEFAULT 0,
  "us_sell_tax_rate" NUMERIC NOT NULL DEFAULT 0,
  "trading_mode" TEXT NOT NULL DEFAULT 'live' CHECK (trading_mode IN ('live', 'mock'))
);
CREATE INDEX IF NOT EXISTS idx_broker_accounts_user_id ON broker_accounts (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_accounts_user_broker ON broker_accounts (user_id, broker);

CREATE TABLE IF NOT EXISTS "broker_account_credentials" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "broker_account_id" INTEGER NOT NULL,
  "app_key_encrypted" TEXT,
  "app_secret_encrypted" TEXT,
  "app_key_expires_at" TEXT,
  "access_token_encrypted" TEXT,
  "access_token_expires_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "mock_app_key" TEXT,
  "mock_app_secret" TEXT,
  "mock_access_token" TEXT,
  "mock_access_token_expires_at" TEXT,
  FOREIGN KEY (broker_account_id) REFERENCES broker_accounts(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_account_credentials_account ON broker_account_credentials (broker_account_id);

CREATE TABLE IF NOT EXISTS "user_settings" (
  "user_id" TEXT NOT NULL,
  "theme" TEXT NOT NULL DEFAULT 'dark',
  "group_name1" TEXT NOT NULL DEFAULT '제목없음',
  "group_name2" TEXT NOT NULL DEFAULT '제목없음',
  "group_name3" TEXT NOT NULL DEFAULT '제목없음',
  "group_name4" TEXT NOT NULL DEFAULT '제목없음',
  "group_name5" TEXT NOT NULL DEFAULT '제목없음',
  "price_refresh_interval" INTEGER NOT NULL DEFAULT 5,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "group_name6" TEXT NOT NULL DEFAULT '제목없음',
  "group_name7" TEXT NOT NULL DEFAULT '제목없음',
  "group_name8" TEXT NOT NULL DEFAULT '제목없음',
  "holdings_rotate_sec" INTEGER NOT NULL DEFAULT 10,
  PRIMARY KEY ("user_id")
);

CREATE TABLE IF NOT EXISTS "instruments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "market" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "name" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'KRW',
  "country" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "mrkt_tp" TEXT,
  UNIQUE ("market", "symbol")
);
CREATE INDEX IF NOT EXISTS idx_instruments_market_symbol ON instruments (market, symbol);

CREATE TABLE IF NOT EXISTS "instrument_venues" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "instrument_id" INTEGER NOT NULL,
  "exchange" TEXT NOT NULL,
  "broker_symbol" TEXT,
  "is_tradable" BOOLEAN NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("instrument_id", "exchange"),
  FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_instrument_venues_instrument_id ON instrument_venues (instrument_id);

CREATE TABLE IF NOT EXISTS "watchlist_v2" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL,
  "instrument_id" INTEGER NOT NULL,
  "group_no" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("user_id", "instrument_id"),
  FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_watchlist_v2_instrument_id ON watchlist_v2 (instrument_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_v2_user_group ON watchlist_v2 (user_id, group_no);

CREATE TABLE IF NOT EXISTS "trading_plans" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL,
  "broker_account_id" INTEGER,
  "instrument_id" INTEGER NOT NULL,
  "venue_id" INTEGER,
  "strategy_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "strategy_config" JSON NOT NULL DEFAULT '{}',
  "current_cycle_id" INTEGER,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("user_id", "instrument_id", "venue_id", "strategy_type"),
  FOREIGN KEY (current_cycle_id) REFERENCES trading_cycles(id) ON DELETE SET NULL,
  FOREIGN KEY (broker_account_id) REFERENCES broker_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (instrument_id) REFERENCES instruments(id),
  FOREIGN KEY (venue_id) REFERENCES instrument_venues(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_trading_plans_instrument_id ON trading_plans (instrument_id);
CREATE INDEX IF NOT EXISTS idx_trading_plans_user_status ON trading_plans (user_id, status);

CREATE TABLE IF NOT EXISTS "trading_cycles" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "trading_id" INTEGER NOT NULL,
  "cycle_no" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'open',
  "started_at" TEXT,
  "completed_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("trading_id", "cycle_no"),
  FOREIGN KEY (trading_id) REFERENCES trading_plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trading_cycles_trading_id ON trading_cycles (trading_id);

CREATE TABLE IF NOT EXISTS "trading_stages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "cycle_id" INTEGER NOT NULL,
  "side" TEXT NOT NULL,
  "stage" INTEGER NOT NULL,
  "percent" NUMERIC,
  "target_price" NUMERIC,
  "target_amount" NUMERIC,
  "target_qty" NUMERIC,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("cycle_id", "side", "stage"),
  FOREIGN KEY (cycle_id) REFERENCES trading_cycles(id) ON DELETE CASCADE,
  CHECK (((side)IN ('BUY', 'SELL'))),
  CHECK ((stage >= 1))
);
CREATE INDEX IF NOT EXISTS idx_trading_stages_cycle_id ON trading_stages (cycle_id);

CREATE TABLE IF NOT EXISTS "trading_orders" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "trading_id" INTEGER NOT NULL,
  "stage_id" INTEGER,
  "broker_account_id" INTEGER,
  "instrument_id" INTEGER NOT NULL,
  "venue_id" INTEGER,
  "side" TEXT NOT NULL,
  "order_type" TEXT NOT NULL DEFAULT 'LIMIT',
  "requested_price" NUMERIC,
  "requested_qty" NUMERIC,
  "requested_amount" NUMERIC,
  "broker_order_no" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "ordered_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "cycle_id" INTEGER,
  "stage_no" INTEGER,
  "order_reason" TEXT,
  FOREIGN KEY (broker_account_id) REFERENCES broker_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (cycle_id) REFERENCES trading_cycles(id) ON DELETE SET NULL,
  FOREIGN KEY (instrument_id) REFERENCES instruments(id),
  FOREIGN KEY (stage_id) REFERENCES trading_stages(id) ON DELETE SET NULL,
  FOREIGN KEY (trading_id) REFERENCES trading_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id) REFERENCES instrument_venues(id) ON DELETE SET NULL,
  CHECK (((side)IN ('BUY', 'SELL')))
);
CREATE INDEX IF NOT EXISTS idx_trading_orders_broker_order_no ON trading_orders (broker_order_no) WHERE (broker_order_no IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_trading_orders_cycle_id ON trading_orders (cycle_id);
CREATE INDEX IF NOT EXISTS idx_trading_orders_stage_id ON trading_orders (stage_id);
CREATE INDEX IF NOT EXISTS idx_trading_orders_trading_id ON trading_orders (trading_id);

CREATE TABLE IF NOT EXISTS "trading_fills" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "order_id" INTEGER NOT NULL,
  "fill_price" NUMERIC NOT NULL,
  "fill_qty" NUMERIC NOT NULL,
  "fill_amount" NUMERIC,
  "broker_fill_no" TEXT,
  "filled_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (order_id) REFERENCES trading_orders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trading_fills_order_id ON trading_fills (order_id);

CREATE TABLE IF NOT EXISTS "plan_status" (
  "user_id" TEXT NOT NULL,
  "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "kr_week" INTEGER NOT NULL DEFAULT 0,
  "kr_month" INTEGER NOT NULL DEFAULT 0,
  "kr_year" INTEGER NOT NULL DEFAULT 0,
  "us_week" INTEGER NOT NULL DEFAULT 0,
  "us_month" INTEGER NOT NULL DEFAULT 0,
  "us_year" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("user_id")
);
CREATE INDEX IF NOT EXISTS idx_plan_status_updated_at ON plan_status (updated_at);

CREATE TABLE IF NOT EXISTS "indicator_trading" (
  "user_id" TEXT NOT NULL,
  "auto_trading_enabled" BOOLEAN NOT NULL DEFAULT 0,
  "api_connected" BOOLEAN NOT NULL DEFAULT 0,
  "stock_info_loaded_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "buy_amount_krw" NUMERIC NOT NULL DEFAULT 1000000,
  "buy_condition" TEXT NOT NULL DEFAULT '',
  "buy_limit_tick_offset" INTEGER NOT NULL DEFAULT 2,
  "sell_limit_tick_offset" INTEGER NOT NULL DEFAULT 2,
  "use_take_profit" BOOLEAN NOT NULL DEFAULT 1,
  "take_profit_percent" NUMERIC NOT NULL DEFAULT 1.5,
  "use_stop_loss" BOOLEAN NOT NULL DEFAULT 1,
  "stop_loss_percent" NUMERIC NOT NULL DEFAULT -1,
  "use_trailing_stop" BOOLEAN NOT NULL DEFAULT 0,
  "trailing_stop_on_percent" NUMERIC NOT NULL DEFAULT 2,
  "trailing_stop_from_high_percent" NUMERIC NOT NULL DEFAULT -1,
  "daily_sell_ma" INTEGER NOT NULL DEFAULT 20,
  "minute_chart_setting" INTEGER NOT NULL DEFAULT 3,
  "minute_sell_ma" INTEGER NOT NULL DEFAULT 20,
  "max_tracking_stocks" INTEGER NOT NULL DEFAULT 90,
  "max_holding_stocks" INTEGER NOT NULL DEFAULT 5,
  "max_usage_amount_krw" NUMERIC NOT NULL DEFAULT 10000000,
  "use_daily_ma_sell" BOOLEAN NOT NULL DEFAULT 0,
  "use_minute_ma_sell" BOOLEAN NOT NULL DEFAULT 0,
  "tracking_stocks" JSON NOT NULL DEFAULT '[]',
  "buy_time_start" TEXT NOT NULL DEFAULT '15:00',
  "buy_time_end" TEXT NOT NULL DEFAULT '15:20',
  "buy_end_market_fill" BOOLEAN NOT NULL DEFAULT 0,
  "use_split_buy" BOOLEAN NOT NULL DEFAULT 0,
  PRIMARY KEY ("user_id")
);

CREATE TABLE IF NOT EXISTS "indicator_positions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL,
  "stock_code" TEXT NOT NULL,
  "stock_name" TEXT NOT NULL DEFAULT '',
  "venue" TEXT NOT NULL DEFAULT 'KRX',
  "buy_condition_seq" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending_buy',
  "buy_order_no" TEXT,
  "buy_order_price" NUMERIC,
  "buy_filled_price" NUMERIC,
  "buy_qty" INTEGER NOT NULL DEFAULT 0,
  "buy_filled_qty" INTEGER NOT NULL DEFAULT 0,
  "buy_ordered_at" TEXT,
  "buy_filled_at" TEXT,
  "sell_order_no" TEXT,
  "sell_order_price" NUMERIC,
  "sell_filled_price" NUMERIC,
  "sell_qty" INTEGER NOT NULL DEFAULT 0,
  "sell_filled_qty" INTEGER NOT NULL DEFAULT 0,
  "sell_reason" TEXT,
  "sell_ordered_at" TEXT,
  "sell_filled_at" TEXT,
  "high_price_since_buy" NUMERIC,
  "last_price" NUMERIC,
  "last_profit_rate" NUMERIC,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "closed_at" TEXT,
  "entry_source" TEXT
);
CREATE INDEX IF NOT EXISTS idx_indicator_pos_closed_sell ON indicator_positions (user_id, sell_filled_at DESC) WHERE ((status)= 'closed');
CREATE INDEX IF NOT EXISTS idx_indicator_pos_open_monitor ON indicator_positions (user_id) WHERE ((status)= 'open');
CREATE INDEX IF NOT EXISTS idx_indicator_pos_user_status ON indicator_positions (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_indicator_pos_open ON indicator_positions (user_id, stock_code) WHERE ((status) IN ('pending_buy', 'open', 'selling'));

CREATE TABLE IF NOT EXISTS "indicator_orders" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL,
  "position_id" INTEGER,
  "stock_code" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "venue" TEXT NOT NULL DEFAULT 'KRX',
  "price_type" TEXT NOT NULL DEFAULT 'limit',
  "order_price" NUMERIC,
  "qty" INTEGER,
  "filled_price" NUMERIC,
  "filled_qty" INTEGER,
  "order_no" TEXT,
  "parent_order_no" TEXT,
  "reason" TEXT,
  "raw_message" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (position_id) REFERENCES indicator_positions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_indicator_orders_ord_no ON indicator_orders (user_id, order_no);
CREATE INDEX IF NOT EXISTS idx_indicator_orders_position ON indicator_orders (position_id);
CREATE INDEX IF NOT EXISTS idx_indicator_orders_user_time ON indicator_orders (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS "stock_list" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "stock_code" TEXT NOT NULL,
  "stock_name" TEXT NOT NULL,
  "mrkt_tp" TEXT,
  UNIQUE ("stock_code")
);

CREATE TABLE IF NOT EXISTS "stock_list_nxt" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "stock_code" TEXT NOT NULL,
  "stock_name" TEXT NOT NULL,
  UNIQUE ("stock_code")
);

CREATE TABLE IF NOT EXISTS "us_stock_list" (
  "ticker" TEXT NOT NULL,
  "stock_name" TEXT NOT NULL DEFAULT '',
  "exchange" TEXT,
  "updated_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("ticker")
);
CREATE INDEX IF NOT EXISTS idx_us_stock_list_name ON us_stock_list (stock_name);
