import React, { useEffect, useMemo, useState } from 'react';
import { Box, Typography } from '@mui/material';
import {
  isTradingHours,
  isNXTTradingHours,
  isKRXAfterMarketHours,
  isKRXExtendedCloseHours,
  isWeekend,
  isHolidaySync,
  isUsTradingHours,
  getUsSessionLabel,
  isUsWeekend,
} from '../utils/tradingHours';

const DOT = {
  krx: 'error.main',
  nxt: 'error.main',
  us: 'warning.main',
  closed: 'text.disabled',
};

/**
 * KRX/US 장세션 칩 + 시계 (오른쪽 정렬용)
 */
const MarketSessionStatusBar = () => {
  const [isInTradingHours, setIsInTradingHours] = useState(isTradingHours());
  const [isInNXTTradingHours, setIsInNXTTradingHours] = useState(isNXTTradingHours());
  const [isInKRXAfterMarket, setIsInKRXAfterMarket] = useState(isKRXAfterMarketHours());
  const [isInKRXExtendedClose, setIsInKRXExtendedClose] = useState(isKRXExtendedCloseHours());
  const [isInUsTradingHours, setIsInUsTradingHours] = useState(isUsTradingHours());
  const [usSessionLabel, setUsSessionLabel] = useState(getUsSessionLabel());
  const [isWeekendDay, setIsWeekendDay] = useState(isWeekend());
  const [isHolidayDay, setIsHolidayDay] = useState(isHolidaySync());
  const [isUsWeekendDay, setIsUsWeekendDay] = useState(isUsWeekend());
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const check = () => {
      setIsInTradingHours(isTradingHours());
      setIsInNXTTradingHours(isNXTTradingHours());
      setIsInKRXAfterMarket(isKRXAfterMarketHours());
      setIsInKRXExtendedClose(isKRXExtendedCloseHours());
      setIsInUsTradingHours(isUsTradingHours());
      setUsSessionLabel(getUsSessionLabel());
      setIsWeekendDay(isWeekend());
      setIsHolidayDay(isHolidaySync());
      setIsUsWeekendDay(isUsWeekend());
    };
    check();
    setCurrentTime(new Date());
    const timeTimer = setInterval(() => setCurrentTime(new Date()), 1000);
    const tradingTimer = setInterval(check, 60000);
    return () => {
      clearInterval(timeTimer);
      clearInterval(tradingTimer);
    };
  }, []);

  const krxMarketStatus = useMemo(() => {
    if (isWeekendDay || isHolidayDay) {
      return { label: 'KRX 휴장', dotColor: DOT.closed };
    }
    if (isInTradingHours) return { label: 'KRX', dotColor: DOT.krx };
    if (isInKRXExtendedClose) return { label: '시간외종가', dotColor: DOT.krx };
    if (isInKRXAfterMarket) return { label: 'KRX애프터', dotColor: DOT.krx };
    if (isInNXTTradingHours) return { label: 'NXT', dotColor: DOT.nxt };
    // 평일·비공휴, 세션 종료 후(또는 개장 전)
    return { label: 'KRX 장마감', dotColor: DOT.closed };
  }, [
    isWeekendDay,
    isHolidayDay,
    isInNXTTradingHours,
    isInTradingHours,
    isInKRXAfterMarket,
    isInKRXExtendedClose,
  ]);

  const usMarketStatus = useMemo(() => {
    if (isInUsTradingHours && usSessionLabel) {
      return { label: usSessionLabel, dotColor: DOT.us };
    }
    if (isUsWeekendDay) {
      return { label: 'US 휴장', dotColor: DOT.closed };
    }
    return { label: 'US 장마감', dotColor: DOT.closed };
  }, [isInUsTradingHours, usSessionLabel, isUsWeekendDay]);

  const formattedTime = useMemo(() => {
    const h = String(currentTime.getHours()).padStart(2, '0');
    const m = String(currentTime.getMinutes()).padStart(2, '0');
    const s = String(currentTime.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }, [currentTime]);

  return (
    <Box
      display="flex"
      alignItems="center"
      gap={2}
      sx={{ flexWrap: 'wrap', ml: 'auto', justifyContent: 'flex-end' }}
    >
      {[
        { key: 'krx', ...krxMarketStatus },
        { key: 'us', ...usMarketStatus },
      ].map((st) => (
        <Box
          key={st.key}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 0.5,
            borderRadius: 999,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'action.selected',
          }}
        >
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor: st.dotColor,
              flexShrink: 0,
            }}
          />
          <Typography
            component="span"
            sx={{ fontSize: '0.8125rem', fontWeight: 600, color: 'text.primary' }}
          >
            {st.label}
          </Typography>
        </Box>
      ))}
      <Typography
        sx={{
          color: (theme) => (theme.palette.mode === 'dark' ? '#9ec400' : '#6a8f00'),
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          fontSize: '1rem',
          textShadow: (theme) =>
            theme.palette.mode === 'dark' ? '0 0 10px rgba(158, 196, 0, 0.4)' : 'none',
        }}
      >
        {formattedTime}
      </Typography>
    </Box>
  );
};

export default MarketSessionStatusBar;
