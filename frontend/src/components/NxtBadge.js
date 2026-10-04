import React from 'react';
import { Box } from '@mui/material';

/** 투명 바탕 원형 테두리 안 한 글자 (기본: NXT 거래가능 N) */
const NxtBadge = ({ size = 18, label = 'N', title = 'NXT 거래가능', sx }) => (
  <Box
    component="span"
    title={title}
    sx={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: '1px solid currentColor',
      backgroundColor: 'transparent',
      color: 'inherit',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '10px',
      fontWeight: 'bold',
      lineHeight: 1,
      flexShrink: 0,
      boxSizing: 'border-box',
      ...sx,
    }}
  >
    {label}
  </Box>
);

export default NxtBadge;
