-- users 관심그룹(이름) 컬럼 제거 (이관은 migrate_users_watch_list_to_settings.js)
ALTER TABLE users DROP COLUMN IF EXISTS watch_list_1;
ALTER TABLE users DROP COLUMN IF EXISTS watch_list_2;
ALTER TABLE users DROP COLUMN IF EXISTS watch_list_3;
ALTER TABLE users DROP COLUMN IF EXISTS watch_list_4;
ALTER TABLE users DROP COLUMN IF EXISTS watch_list_5;
ALTER TABLE users DROP COLUMN IF EXISTS us_watch_list_1;
ALTER TABLE users DROP COLUMN IF EXISTS us_watch_list_2;
ALTER TABLE users DROP COLUMN IF EXISTS us_watch_list_3;
ALTER TABLE users DROP COLUMN IF EXISTS us_watch_list_4;
ALTER TABLE users DROP COLUMN IF EXISTS us_watch_list_5;
