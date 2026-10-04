-- completed_buy 테이블 생성 (completedBuyStore용)
CREATE TABLE IF NOT EXISTS completed_buy (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    stock_code VARCHAR(20) NOT NULL,
    buy_price DECIMAL(15,2),
    buy_qty INTEGER,
    sell_completed CHAR(1) DEFAULT 'N',
    sell_price DECIMAL(15,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_completed_buy_user_id ON completed_buy(user_id);
CREATE INDEX IF NOT EXISTS idx_completed_buy_stock_code ON completed_buy(stock_code);
CREATE INDEX IF NOT EXISTS idx_completed_buy_date_time ON completed_buy(date_time);
CREATE INDEX IF NOT EXISTS idx_completed_buy_sell_completed ON completed_buy(sell_completed);

