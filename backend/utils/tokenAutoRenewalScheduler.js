const cron = require('node-cron');
const { getAllUsers } = require('./userStore');
const kiwoomAPI = require('../services/kiwoomApi');
const {
  getBrokerKiwoomBundle,
  saveAccessToken,
} = require('./brokerCredentialsStore');

/**
 * 사용자에게 토큰 발급 (broker_account_credentials)
 * @param {Object} user - 사용자 객체
 * @returns {Promise<boolean>} 성공 여부
 */
const generateTokenForUser = async (user) => {
  try {
    const bundle = await getBrokerKiwoomBundle(user.id);
    if (!bundle?.appKey || !bundle?.appSecret) {
      console.log(`[토큰 자동 발급] 사용자 ${user.id} (${user.username}): App Key/Secret이 없어 스킵`);
      return false;
    }

    console.log(`[토큰 자동 발급] 사용자 ${user.id} (${user.username}) 토큰 발급 시작`);

    let tokenData;
    try {
      tokenData = await kiwoomAPI.generateAccessToken(bundle.appKey, bundle.appSecret);
    } catch (error) {
      if (error.data?.return_code === 3 && error.message?.includes('8050')) {
        console.error(`[토큰 자동 발급] 사용자 ${user.id} (${user.username}): 단말기 인증 실패 - IP 주소 등록 필요`);
        return false;
      }
      throw error;
    }

    let expiresAt;
    let expiresIn = 86400;

    if (tokenData.expires_dt) {
      const expiresDt = tokenData.expires_dt;
      try {
        const year = expiresDt.substring(0, 4);
        const month = expiresDt.substring(4, 6);
        const day = expiresDt.substring(6, 8);
        const hour = expiresDt.substring(8, 10);
        const minute = expiresDt.substring(10, 12);
        const second = expiresDt.substring(12, 14);
        const kstString = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
        const expiresDateUTC = new Date(kstString);
        expiresAt = expiresDateUTC.toISOString();
        expiresIn = Math.floor((expiresDateUTC - Date.now()) / 1000);
        if (expiresIn < 0) expiresIn = 86400;
      } catch (e) {
        console.error(`[토큰 자동 발급] 사용자 ${user.id} (${user.username}): expires_dt 파싱 실패:`, e);
        expiresIn = tokenData.expires_in || 86400;
        expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      }
    } else {
      expiresIn = tokenData.expires_in || 86400;
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    }

    await saveAccessToken(user.id, {
      accessToken: tokenData.access_token,
      expiresAt,
    });

    console.log(`[토큰 자동 발급] 사용자 ${user.id} (${user.username}) 토큰 발급 완료 (만료일: ${expiresAt})`);
    return true;
  } catch (error) {
    console.error(`[토큰 자동 발급] 사용자 ${user.id} (${user.username}) 토큰 발급 실패:`, error.message);
    return false;
  }
};

/**
 * 모든 사용자에게 토큰 자동 발급
 */
const renewAllUserTokens = async () => {
  try {
    console.log('[토큰 자동 발급] 모든 사용자 토큰 자동 발급 시작');

    const users = await getAllUsers();
    console.log(`[토큰 자동 발급] 총 ${users.length}명의 사용자 발견`);

    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for (const user of users) {
      const bundle = await getBrokerKiwoomBundle(user.id);
      if (!bundle?.appKey || !bundle?.appSecret) {
        skipCount += 1;
        continue;
      }
      const result = await generateTokenForUser(user);
      if (result) successCount += 1;
      else failCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `[토큰 자동 발급] 완료 — 성공 ${successCount}, 실패 ${failCount}, 스킵 ${skipCount}`
    );
  } catch (error) {
    console.error('[토큰 자동 발급] 전체 작업 실패:', error.message);
  }
};

/**
 * 토큰 자동 발급 스케줄러 시작
 * 미국 애프터마켓(~20:00 ET ≈ 익일 09:00 KST 전후) 대비 07:50 KST
 */
function startScheduler() {
  cron.schedule(
    '50 7 * * *',
    async () => {
      console.log('[토큰 자동 발급 스케줄러] 스케줄 실행 (07:50)');
      await renewAllUserTokens();
    },
    { timezone: 'Asia/Seoul' }
  );
  console.log('[토큰 자동 발급 스케줄러] 스케줄러 시작됨 (매일 07:50 실행)');
}

module.exports = {
  renewAllUserTokens,
  generateTokenForUser,
  startScheduler,
};
