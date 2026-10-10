/**
 * 게스트 모드 — guest@plango.today 로 로그인한 경우
 * 비밀번호·계좌번호·실전/모의 선택·키움 인증키는 변경할 수 없다.
 */
const { getUserById } = require('./userStore');

const GUEST_EMAIL = 'guest@plango.today';

const isGuestEmail = (email) => String(email || '').trim().toLowerCase() === GUEST_EMAIL;

const isGuestUser = async (userId) => {
  try {
    return isGuestEmail((await getUserById(userId))?.email);
  } catch {
    return false;
  }
};

/** 게스트면 403 으로 막는 미들웨어 */
const rejectGuest = (message) => async (req, res, next) => {
  if (await isGuestUser(req.user?.userId)) {
    return res.status(403).json({ error: message, code: 'GUEST_READONLY' });
  }
  return next();
};

module.exports = {
  GUEST_EMAIL,
  isGuestEmail,
  isGuestUser,
  rejectGuest,
};
