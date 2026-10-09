import React from 'react';
import { Box, Container } from '@mui/material';
import AdSlot from './AdSlot';

export const PAGE_MAX_WIDTH = 1656;

/** 화면 상단 제목 막대 (라이트 모드: 리포트와 같은 테두리·둥근 모서리) */
export const pageHeaderSx = (theme) => ({
  px: 2,
  py: 1.25,
  mb: 2,
  ...(theme.palette.mode !== 'dark' && {
    border: '1px solid',
    borderColor: 'divider',
    borderRadius: 2,
  }),
});

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
          top: 80,
          display: { xs: 'none', lg: 'flex' },
        }}
      />
    )}
  </Box>
);

export default PageFrame;
