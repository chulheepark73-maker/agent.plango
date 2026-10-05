import React from 'react';
import { Paper, Box, Typography } from '@mui/material';
import ConstructionIcon from '@mui/icons-material/Construction';
import PageFrame from '../components/PageFrame';

/** 아직 구현되지 않은 사이드 메뉴 화면 */
const ComingSoon = ({ title, Icon = ConstructionIcon }) => (
  <PageFrame>
    <Paper sx={{ px: 2, py: 1.25, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Icon sx={{ fontSize: '1.05rem' }} />
        <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
          {title}
        </Typography>
      </Box>
    </Paper>
    <Paper sx={{ p: 6, textAlign: 'center', color: 'text.secondary' }}>
      <ConstructionIcon sx={{ fontSize: 40, mb: 1 }} />
      <Typography>준비 중인 화면입니다.</Typography>
    </Paper>
  </PageFrame>
);

export default ComingSoon;
