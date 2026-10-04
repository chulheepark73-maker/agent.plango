-- user_settings: 관심그룹명 1~8 보장, 9·10 제거
-- 서버 적용용

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS group_name6 VARCHAR(50) NOT NULL DEFAULT '제목없음';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS group_name7 VARCHAR(50) NOT NULL DEFAULT '제목없음';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS group_name8 VARCHAR(50) NOT NULL DEFAULT '제목없음';

ALTER TABLE user_settings DROP COLUMN IF EXISTS group_name9;
ALTER TABLE user_settings DROP COLUMN IF EXISTS group_name10;
