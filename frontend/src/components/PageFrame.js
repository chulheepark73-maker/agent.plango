import React from 'react';
import { Box, Container } from '@mui/material';
import AdSlot from './AdSlot';

export const PAGE_MAX_WIDTH = 1656;

/** 공통 화면 틀: 본문(왼쪽 정렬) + 오른쪽 광고 자리 */
const PageFrame = ({ children, maxWidth = PAGE_MAX_WIDTH, showAd = true, sx }) => (
  <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '30px', ml: '6px' }}>
    <Container
      maxWidth={false}
      disableGutters
      sx={{
        mx: 0,
        flex: '1 1 auto',
        minWidth: 0,
        maxWidth,
        bgcolor: 'background.default',
        minHeight: '100%',
        ...sx,
      }}
    >
      {children}
    </Container>
    {showAd && (
      <AdSlot
        sx={{
          flexShrink: 0,
          position: 'sticky',
          top: 88,
          display: { xs: 'none', lg: 'flex' },
        }}
      />
    )}
  </Box>
);

export default PageFrame;
