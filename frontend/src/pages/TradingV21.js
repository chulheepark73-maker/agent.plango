import React from 'react';
import { Paper, Typography, Box } from '@mui/material';
import PageFrame from '../components/PageFrame';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import Watchlist from './Watchlist';
import MarketSessionStatusBar from '../components/MarketSessionStatusBar';

/**
 * 자동매매 Ver.2
 * - watchlist_v2 + instruments (KRX/US 통합)
 * - 종목검색: POST /market/stocks/search
 * - 추가: instruments upsert → watchlist_v2
 */
const TradingV21 = () => {
  return (
    <PageFrame>
      <Paper sx={{ px: 2, py: 1.25, mb: 2 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: 'wrap',
            justifyContent: 'space-between',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <AccountTreeIcon sx={{ fontSize: '1.05rem', color: '#80cbc4' }} />
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
              관심종목 - 매매설정 Ver.2
            </Typography>
          </Box>
          <MarketSessionStatusBar />
        </Box>
      </Paper>
      <Watchlist noContainer />
    </PageFrame>
  );
};

export default TradingV21;
