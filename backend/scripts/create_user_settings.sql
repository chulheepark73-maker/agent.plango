-- user_settings: V2 등 사용자별 UI/앱 설정 (users 관심그룹명 컬럼과 별개)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme VARCHAR(20) NOT NULL DEFAULT 'dark',
  group_name1 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  group_name2 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  group_name3 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  group_name4 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  group_name5 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  group_name6 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  group_name7 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  group_name8 VARCHAR(50) NOT NULL DEFAULT '제목없음',
  price_refresh_interval INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 기존 DB에 6~8이 없을 때
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS group_name6 VARCHAR(50) NOT NULL DEFAULT '제목없음';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS group_name7 VARCHAR(50) NOT NULL DEFAULT '제목없음';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS group_name8 VARCHAR(50) NOT NULL DEFAULT '제목없음';

-- 임시로 추가됐던 9·10 컬럼 제거
ALTER TABLE user_settings DROP COLUMN IF EXISTS group_name9;
ALTER TABLE user_settings DROP COLUMN IF EXISTS group_name10;
