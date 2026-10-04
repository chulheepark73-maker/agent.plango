CREATE TABLE IF NOT EXISTS plan_status (
    user_id VARCHAR(50) PRIMARY KEY
        REFERENCES users(id)
        ON DELETE CASCADE,

    kr_week BIGINT NOT NULL DEFAULT 0,
    kr_month BIGINT NOT NULL DEFAULT 0,
    kr_year BIGINT NOT NULL DEFAULT 0,
    us_week BIGINT NOT NULL DEFAULT 0,
    us_month BIGINT NOT NULL DEFAULT 0,
    us_year BIGINT NOT NULL DEFAULT 0,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 레거시 week/month/year → kr_* (이미 새 스키마면 no-op)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_status' AND column_name = 'week'
  ) THEN
    ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS kr_week BIGINT NOT NULL DEFAULT 0;
    UPDATE plan_status SET kr_week = COALESCE(week, 0) WHERE COALESCE(kr_week, 0) = 0;
    ALTER TABLE plan_status DROP COLUMN IF EXISTS week;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_status' AND column_name = 'month'
  ) THEN
    ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS kr_month BIGINT NOT NULL DEFAULT 0;
    UPDATE plan_status SET kr_month = COALESCE(month, 0) WHERE COALESCE(kr_month, 0) = 0;
    ALTER TABLE plan_status DROP COLUMN IF EXISTS month;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_status' AND column_name = 'year'
  ) THEN
    ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS kr_year BIGINT NOT NULL DEFAULT 0;
    UPDATE plan_status SET kr_year = COALESCE(year, 0) WHERE COALESCE(kr_year, 0) = 0;
    ALTER TABLE plan_status DROP COLUMN IF EXISTS year;
  END IF;
END $$;

ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS kr_week BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS kr_month BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS kr_year BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS us_week BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS us_month BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plan_status ADD COLUMN IF NOT EXISTS us_year BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_plan_status_updated_at
ON plan_status(updated_at);
