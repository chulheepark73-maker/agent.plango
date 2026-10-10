/** 게스트 모드 계정 — 비밀번호·계좌번호·실전/모의·인증키 변경 불가 (서버에서도 막는다) */
export const GUEST_EMAIL = 'guest@plango.today';

export const isGuestEmail = (email) => String(email || '').trim().toLowerCase() === GUEST_EMAIL;
