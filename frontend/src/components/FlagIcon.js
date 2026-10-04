import React from 'react';
import { Box } from '@mui/material';

const SOLID = ['M-6-25H6', 'M-6-22H6', 'M-6-19H6'];
const BROKEN = (y) => `M-6${y}H-1M1${y}H6`;
const TRIGRAMS = [
  { rotate: -56.31, d: SOLID.join('') },
  { rotate: 56.31, d: [BROKEN(-25), 'M-6-22H6', BROKEN(-19)].join('') },
  { rotate: -123.69, d: ['M-6-25H6', BROKEN(-22), 'M-6-19H6'].join('') },
  { rotate: 123.69, d: [BROKEN(-25), BROKEN(-22), BROKEN(-19)].join('') },
];

const KoreaFlag = () => (
  <svg viewBox="-36 -24 72 48" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
    <rect x="-36" y="-24" width="72" height="48" fill="#fff" />
    <g transform="rotate(33.69)">
      <circle r="12" fill="#0047a0" />
      <path d="M-12 0A12 12 0 0 1 12 0Z" fill="#cd2e3a" />
      <circle cx="-6" r="6" fill="#cd2e3a" />
      <circle cx="6" r="6" fill="#0047a0" />
    </g>
    {TRIGRAMS.map((t) => (
      <path key={t.rotate} d={t.d} transform={`rotate(${t.rotate})`} stroke="#000" strokeWidth="2" />
    ))}
  </svg>
);

const US_W = 76;
const US_H = 40;
const STRIPE = US_H / 13;

const UsFlag = () => (
  <svg viewBox={`0 0 ${US_W} ${US_H}`} width="100%" height="100%" preserveAspectRatio="none">
    <rect width={US_W} height={US_H} fill="#fff" />
    {Array.from({ length: 7 }, (_, i) => (
      <rect key={i} y={i * 2 * STRIPE} width={US_W} height={STRIPE} fill="#b22234" />
    ))}
    <rect width={US_W * 0.4} height={STRIPE * 7} fill="#3c3b6e" />
    {Array.from({ length: 4 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => (
        <circle
          key={`${r}-${c}`}
          cx={3.5 + c * 6}
          cy={2.8 + r * 5.2}
          r="1"
          fill="#fff"
        />
      ))
    )}
  </svg>
);

/** 국기 아이콘 (country: 'KR' | 'US'). size는 가로 기준 */
const FlagIcon = ({ country = 'KR', size = 22, sx }) => (
  <Box
    component="span"
    role="img"
    aria-label={country === 'US' ? '미국' : '대한민국'}
    sx={{
      display: 'inline-flex',
      width: size,
      height: Math.round((size * 2) / 3),
      borderRadius: '2px',
      overflow: 'hidden',
      flexShrink: 0,
      boxShadow: '0 0 0 1px rgba(255,255,255,0.25)',
      ...sx,
    }}
  >
    {country === 'US' ? <UsFlag /> : <KoreaFlag />}
  </Box>
);

export default FlagIcon;
