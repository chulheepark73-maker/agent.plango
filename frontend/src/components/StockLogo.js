import React, { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOn';
import { API_URL } from '../utils/axios';

/** 종목 로고(백엔드 /logo 프록시). 로고가 없으면 기본 아이콘 */
const StockLogo = ({ stockCode, isUs = false, size = 26, sx }) => {
  const code = String(stockCode || '').trim();
  const [failed, setFailed] = useState(!code);
  const fallbackBg = isUs ? '#9a7b12' : '#1f6feb';

  useEffect(() => {
    setFailed(!code);
  }, [code, isUs]);

  const src = code
    ? `${API_URL}/logo/${isUs ? 'us' : 'kr'}/${encodeURIComponent(isUs ? code.toUpperCase() : code.slice(0, 6))}`
    : '';

  return (
    <Box
      component="span"
      sx={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: failed ? fallbackBg : '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden',
        ...sx,
      }}
    >
      {failed ? (
        <>
          <PersonIcon sx={{ fontSize: size * 0.62, color: '#fff' }} />
          <MonetizationOnIcon
            sx={{
              position: 'absolute',
              right: size * 0.12,
              bottom: size * 0.12,
              fontSize: size * 0.34,
              color: '#fff',
              bgcolor: fallbackBg,
              borderRadius: '50%',
            }}
          />
        </>
      ) : (
        <Box
          component="img"
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          sx={{ width: '100%', height: '100%', objectFit: isUs ? 'contain' : 'cover', display: 'block' }}
        />
      )}
    </Box>
  );
};

export default StockLogo;
