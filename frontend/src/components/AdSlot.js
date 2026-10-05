import React from 'react';
import { Box, Typography } from '@mui/material';

export const AD_SLOT_WIDTH = 160;

/** 광고 자리 (실제 광고 연동 전 자리 표시) */
const AdSlot = ({ height = 600, sx }) => (
  <Box
    component="aside"
    sx={{
      width: AD_SLOT_WIDTH,
      height,
      border: '1px dashed',
      borderColor: 'divider',
      borderRadius: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'text.disabled',
      ...sx,
    }}
  >
    <Typography variant="body2">광고 영역 ({AD_SLOT_WIDTH}×{height})</Typography>
  </Box>
);

export default AdSlot;
