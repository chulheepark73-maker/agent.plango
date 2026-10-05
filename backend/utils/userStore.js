/**
 * 에이전트 주인(1명) 사용자 정보
 * - 회원 원본은 중앙 서버. 로컬 users 행은 FK(trading_plans 등) 유지를 위한 미러.
 * - getUserById / getAllUsers 는 페어링된 주인만 반환.
 */
const pool = require('./tradingDb');
const { getOwnerUserId, isOwner } = require('./agentIdentity');

const CENTRAL_PASSWORD_PLACEHOLDER = '!central-managed';

const toIsoOrNull = (value) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

const mapUserRow = (user) => ({
  id: user.id,
  email: user.email,
  username: user.username,
  phoneNumber: user.phone_number || null,
  status: user.status || 'active',
  createdAt: toIsoOrNull(user.created_at),
  updatedAt: toIsoOrNull(user.updated_at),
});

/** 중앙 계정 정보를 로컬 users 미러에 반영 */
const upsertOwnerUser = async ({ id, email, username, phoneNumber }) => {
  const result = await pool.query(
    `INSERT INTO users (id, email, username, phone_number, password, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       username = EXCLUDED.username,
       phone_number = COALESCE(EXCLUDED.phone_number, users.phone_number),
       updated_at = NOW()
     RETURNING *`,
    [
      String(id),
      email || `${id}@central.local`,
      username || email || String(id),
      phoneNumber || null,
      CENTRAL_PASSWORD_PLACEHOLDER,
    ]
  );
  return mapUserRow(result.rows[0]);
};

const getUserById = async (userId) => {
  if (!isOwner(userId)) return null;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [String(userId)]);
    return result.rows.length ? mapUserRow(result.rows[0]) : null;
  } catch (error) {
    console.error('[userStore] getUserById 오류:', error);
    throw error;
  }
};

/** 스케줄러/모니터용: 이 에이전트의 주인만 */
const getAllUsers = async () => {
  const ownerId = getOwnerUserId();
  if (!ownerId) return [];
  const owner = await getUserById(ownerId);
  return owner ? [owner] : [];
};

module.exports = {
  upsertOwnerUser,
  getUserById,
  getAllUsers,
};
